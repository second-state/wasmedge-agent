import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEGACY_NAME_WARNINGS } from "../src/config.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const globalPath = join(agentDir, "settings.json");
	const projectPath = join(projectDir, ".wasmedge-agent", "settings.json");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".wasmedge-agent"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	const writeSettings = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value));
	const readSettings = (path: string): Record<string, unknown> =>
		JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

	describe("on-disk settings file", () => {
		it("preserves keys it does not own, including ones written after load", async () => {
			writeSettings(globalPath, { theme: "dark", defaultModel: "claude-sonnet" });
			const manager = SettingsManager.create(projectDir, agentDir);

			// A second writer (another process, or the user's editor) adds keys after load.
			writeSettings(globalPath, {
				...readSettings(globalPath),
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
				defaultThinkingLevel: "low",
			});

			manager.setDefaultThinkingLevel("high");
			manager.setTheme("light");
			await manager.flush();

			expect(readSettings(globalPath)).toEqual({
				theme: "light",
				defaultModel: "claude-sonnet",
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
				// In-memory changes win for keys the manager owns.
				defaultThinkingLevel: "high",
			});
		});

		it("reloads rewritten settings from disk", async () => {
			writeSettings(globalPath, { theme: "dark", extensions: ["/before.ts"] });
			const manager = SettingsManager.create(projectDir, agentDir);

			writeSettings(globalPath, { theme: "light", extensions: ["/after.ts"], defaultModel: "claude-sonnet" });
			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		// An unparsable file must never be clobbered: the user's settings would be lost.
		it.each<[string, string, (manager: SettingsManager) => void, string]>([
			["global", globalPath, (manager) => manager.setRlmMaxDepth(3), "Global settings not saved"],
			[
				"project",
				projectPath,
				(manager) => manager.setProjectPackages(["npm:test-pkg"]),
				"Project settings not saved",
			],
		])("keeps invalid %s settings on disk and reports the failed save", async (scope, path, mutate, message) => {
			const invalid = `{ invalid ${scope} json`;
			writeFileSync(path, invalid);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainErrors().map((entry) => entry.scope)).toEqual([scope]);
			expect(manager.drainErrors()).toEqual([]);

			mutate(manager);
			await manager.flush();

			const errors = manager.drainErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0]?.scope).toBe(scope);
			expect(errors[0]?.error.message).toContain(message);
			expect(readFileSync(path, "utf-8")).toBe(invalid);
		});

		it("keeps the previously loaded values when a reload finds invalid JSON", async () => {
			writeSettings(globalPath, { theme: "dark" });
			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(globalPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
		});

		it("drains errors per scope", () => {
			writeFileSync(globalPath, "{ invalid global json");
			writeFileSync(projectPath, "{ invalid project json");
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.drainErrors("global").map((entry) => entry.scope)).toEqual(["global"]);
			expect(manager.drainErrors().map((entry) => entry.scope)).toEqual(["project"]);
		});

		it("creates the project settings directory only when project settings are written", async () => {
			writeSettings(globalPath, { theme: "dark" });
			rmSync(join(projectDir, ".wasmedge-agent"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(existsSync(join(projectDir, ".wasmedge-agent"))).toBe(false);
			expect(manager.getTheme()).toBe("dark");

			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			expect(existsSync(projectPath)).toBe(true);
		});
	});

	describe("project vs global precedence", () => {
		it.each<[string, unknown, unknown, (manager: SettingsManager) => unknown, unknown]>([
			[
				"project sessionDir overrides global",
				{ sessionDir: "/global/sessions" },
				{ sessionDir: "./sessions" },
				(manager) => manager.getSessionDir(),
				"./sessions",
			],
			[
				"global sessionDir expands ~",
				{ sessionDir: "~/sessions" },
				{},
				(manager) => manager.getSessionDir(),
				join(homedir(), "sessions"),
			],
			[
				"mcpServers stay global-only",
				{ mcpServers: { shared: { type: "http", url: "https://global.shared/mcp" } } },
				{ mcpServers: { shared: { type: "http", url: "https://project.shared/mcp" } } },
				(manager) => manager.getGlobalMcpServers(),
				{ shared: { type: "http", url: "https://global.shared/mcp" } },
			],
			[
				"idle eviction stays global-only",
				{ idleEvictionMinutes: 60 },
				{ idleEvictionMinutes: 30 },
				(manager) => manager.getIdleEvictionMinutes(),
				60,
			],
			[
				"autonomous limits merge project over global, dropping invalid entries",
				{ autonomous: { maxContinuations: 10, maxTurns: 40 } },
				{ autonomous: { maxContinuations: "unlimited", maxTokens: "one million" } },
				(manager) => manager.getAutonomousLimits(),
				{
					maxContinuations: Number.MAX_SAFE_INTEGER,
					maxTurns: 40,
					maxTokens: undefined,
					timeoutMs: undefined,
				},
			],
		])("%s", (_label, global, project, read, expected) => {
			writeSettings(globalPath, global);
			writeSettings(projectPath, project);

			expect(read(SettingsManager.create(projectDir, agentDir))).toEqual(expected);
		});
	});

	describe("rustCell", () => {
		it("loads configured crates and lets the project replace the global list", () => {
			const extra = { name: "itoa", version: "1.0.18" };
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ rustCell: { preludeExtra: [extra] } }));
			expect(SettingsManager.create(projectDir, agentDir).getRustCellPreludeExtra()).toEqual([
				{ ...extra, features: [], defaultFeatures: true },
			]);
			writeFileSync(
				join(projectDir, ".wasmedge-agent", "settings.json"),
				JSON.stringify({ rustCell: { preludeExtra: [] } }),
			);
			expect(SettingsManager.create(projectDir, agentDir).getRustCellPreludeExtra()).toEqual([]);
			expect(SettingsManager.inMemory({}).getRustCellPreludeExtra()).toEqual([]);
		});

		it("merges resource limits and supports an explicit null override", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ rustCell: { cellGasLimit: 500_000, cellMemoryPageLimit: 64 } }),
			);
			writeFileSync(
				join(projectDir, ".wasmedge-agent", "settings.json"),
				JSON.stringify({ rustCell: { cellGasLimit: null } }),
			);
			expect(SettingsManager.create(projectDir, agentDir).getRustCellResourceLimits()).toEqual({
				cellGasLimit: null,
				cellMemoryPageLimit: 64,
			});
			expect(SettingsManager.inMemory({}).getRustCellResourceLimits()).toEqual({
				cellGasLimit: undefined,
				cellMemoryPageLimit: undefined,
			});
		});

		it.each([
			["cellGasLimit", "100"],
			["cellGasLimit", 0],
			["cellGasLimit", -1],
			["cellGasLimit", 1.5],
			["cellGasLimit", 0x1_0000_0000],
			["cellMemoryPageLimit", false],
			["cellMemoryPageLimit", 65_537],
			["cellMemoryPageLimit", 0],
		])("rejects invalid %s=%s instead of disabling the limit", (name, value) => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ rustCell: { [name]: value } }));
			expect(() => SettingsManager.create(projectDir, agentDir).getRustCellResourceLimits()).toThrow(
				`rustCell.${name} must be an integer`,
			);
		});

		it("loads cellTimeoutMs and floors fractional values", () => {
			expect(SettingsManager.inMemory({ rustCell: { cellTimeoutMs: 300_000 } }).getRustCellTimeoutMs()).toBe(
				300_000,
			);
			expect(SettingsManager.inMemory({ rustCell: { cellTimeoutMs: 90_000.7 } }).getRustCellTimeoutMs()).toBe(
				90_000,
			);
		});

		it("falls through to the engine default on missing or junk values", () => {
			expect(SettingsManager.inMemory({}).getRustCellTimeoutMs()).toBeUndefined();
			expect(SettingsManager.inMemory({ rustCell: {} }).getRustCellTimeoutMs()).toBeUndefined();
			expect(SettingsManager.inMemory({ rustCell: { cellTimeoutMs: 0 } }).getRustCellTimeoutMs()).toBeUndefined();
			expect(SettingsManager.inMemory({ rustCell: { cellTimeoutMs: -5 } }).getRustCellTimeoutMs()).toBeUndefined();
			expect(
				SettingsManager.inMemory({
					rustCell: { cellTimeoutMs: Number.NaN },
				}).getRustCellTimeoutMs(),
			).toBeUndefined();
		});
	});

	// Telemetry may only ever be narrowed: no project file or runtime override can opt a user back in.
	describe("telemetry privacy controls", () => {
		it.each<[string, unknown, unknown, boolean]>([
			[
				"a global opt-out survives project opt-in",
				{ enabled: false, noticeShown: false },
				{ enabled: true, noticeShown: true },
				false,
			],
			["a project opt-out disables globally enabled telemetry", { enabled: true }, { enabled: false }, false],
			["both enabled keeps telemetry on", { enabled: true }, { enabled: true }, true],
		])("%s", (_label, global, project, expected) => {
			writeSettings(globalPath, { telemetry: global });
			writeSettings(projectPath, { telemetry: project });

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTelemetryEnabled()).toBe(expected);
			if (!expected) expect(manager.getTelemetryNoticeShown()).toBe(false);
		});

		it.each<[string, boolean, boolean, boolean]>([
			["further disable telemetry", true, false, false],
			["not re-enable a global opt-out", false, true, false],
		])("runtime overrides can %s", (_label, globalEnabled, overrideEnabled, expected) => {
			writeSettings(globalPath, { telemetry: { enabled: globalEnabled, noticeShown: true } });
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.applyOverrides({ telemetry: { enabled: overrideEnabled, noticeShown: overrideEnabled } });

			expect(manager.getTelemetryEnabled()).toBe(expected);
		});
	});

	// Park bounds are clamped like the other wait bounds: one week per park at most,
	// and non-finite park settings fall back to the defaults.
	describe("provider park bounds", () => {
		it("clamps park bounds and falls back to defaults on invalid values", () => {
			const wait = SettingsManager.inMemory({
				retry: { provider: { waitForUsage: { maxPauseMs: 365 * 86_400_000, maxParks: 99 } } },
			}).getProviderWaitSettings();
			expect([wait.pauseUntilReset, wait.maxPauseMs, wait.maxParks]).toEqual([true, 7 * 86_400_000, 99]);
			const invalid = SettingsManager.inMemory({
				retry: { provider: { waitForUsage: { maxPauseMs: Number.NaN, maxParks: -1 } } },
			}).getProviderWaitSettings();
			expect([invalid.maxPauseMs, invalid.maxParks]).toEqual([86_400_000, 0]);
		});
	});
});

describe("SettingsManager project-local fallback (.prime/agent)", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		LEGACY_NAME_WARNINGS.length = 0;
	});

	function isolatedDirs(): { agentDir: string; projectDir: string } {
		const root = mkdtempSync(join(tmpdir(), "wasmedge-agent-settings-fallback-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		return { agentDir, projectDir };
	}

	it("still reads project settings from the legacy .prime/agent directory, and warns once", async () => {
		const { agentDir, projectDir } = isolatedDirs();
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		writeFileSync(join(projectDir, ".prime", "agent", "settings.json"), JSON.stringify({ theme: "legacy-theme" }));

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getProjectSettings().theme).toBe("legacy-theme");
		expect(LEGACY_NAME_WARNINGS).toHaveLength(1);
		expect(LEGACY_NAME_WARNINGS[0]).toContain(join(".prime", "agent"));

		manager.setProjectSkillPaths(["./local-skills"]);
		await manager.flush();
		expect(existsSync(join(projectDir, ".wasmedge-agent"))).toBe(false);
		const saved = JSON.parse(readFileSync(join(projectDir, ".prime", "agent", "settings.json"), "utf8"));
		expect(saved.theme).toBe("legacy-theme");
		expect(saved.skills).toEqual(["./local-skills"]);
	});
});
