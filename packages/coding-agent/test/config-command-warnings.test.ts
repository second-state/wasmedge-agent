import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, LEGACY_NAME_WARNINGS } from "../src/config.js";
import { resetReportedLegacyWarnings } from "../src/migrations.js";
import { resolveThemeName } from "../src/modes/interactive/theme/theme.js";
import { handleConfigCommand } from "../src/package-manager-cli.js";
import { captureStderr, type StderrCapture } from "./capture-stderr.js";

// The real selector opens a TUI and blocks on a keypress. What matters here is
// that it runs *inside* the command and can queue a deprecation of its own --
// it calls initTheme(), which resolves a renamed built-in theme -- so the stub
// does exactly that and nothing else.
vi.mock("../src/cli/config-selector.js", () => ({
	selectConfig: vi.fn(async () => {
		resolveThemeName("prime");
	}),
}));

/** `config` never returns to main(): it ends the process itself. So main()'s
 *  drain cannot report for it, and it is a command that collects warnings
 *  while it runs. Before the fix it accepted both compatibility fallbacks in
 *  silence. */
describe("config command deprecation warnings", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousCwd = process.cwd();
	let stderr: StderrCapture;
	let exitCodes: (number | undefined)[];

	beforeEach(() => {
		exitCodes = [];
		LEGACY_NAME_WARNINGS.length = 0;
		resetReportedLegacyWarnings();
		// The descriptor, not the stream: the reporter writes past
		// process.stderr.write so that the exit after it cannot drop anything.
		stderr = captureStderr();
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code);
		}) as never);
	});

	afterEach(() => {
		stderr.restore();
		vi.restoreAllMocks();
		process.chdir(previousCwd);
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		LEGACY_NAME_WARNINGS.length = 0;
		resetReportedLegacyWarnings();
	});

	function projectWithLegacyConfigDir(): string {
		const base = mkdtempSync(join(tmpdir(), "wasmedge-agent-config-cmd-"));
		tempDirs.push(base);
		mkdirSync(join(base, "project", ".prime", "agent"), { recursive: true });
		process.env[ENV_AGENT_DIR] = join(base, "agent");
		return join(base, "project");
	}

	it("reports the legacy project directory and the renamed theme before it exits", async () => {
		const projectDir = projectWithLegacyConfigDir();
		process.chdir(projectDir);

		await handleConfigCommand(["config"]);

		const reported = stderr.read();
		// Queued before the selector runs, by resolving the project directory...
		expect(reported).toContain("is deprecated; rename it to");
		// ...and queued by the selector itself, after that.
		expect(reported).toContain('Theme "prime" was renamed');
		expect(exitCodes).toEqual([0]);
	});

	it("reports each warning once, not once per drain point", async () => {
		const projectDir = projectWithLegacyConfigDir();
		process.chdir(projectDir);

		await handleConfigCommand(["config"]);

		const reported = stderr.read();
		expect(reported.split('Theme "prime" was renamed')).toHaveLength(2);
		expect(reported.split("is deprecated; rename it to")).toHaveLength(2);
	});

	it("stays out of the way of every other command", async () => {
		await expect(handleConfigCommand(["package", "list"])).resolves.toBe(false);

		expect(stderr.read()).toBe("");
		expect(exitCodes).toEqual([]);
	});
});
