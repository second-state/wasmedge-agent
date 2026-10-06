import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.js";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { allToolNames, createAllToolDefinitions } from "../../../src/core/tools/index.js";
import { getCodingAgentFixtureModel } from "../../fixture-models.js";

const legacyBashExtension = (pi: ExtensionAPI) => {
	pi.on("session_start", () => {
		pi.registerTool({
			name: "bash",
			label: "Custom Bash",
			description: "Tool registered from session_start",
			promptSnippet: "Run custom shell behavior",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
	});
};

describe("regression #4428: remove legacy pi-mono built-in tools", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-remove-legacy-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers only rust and bash as built-in tools and keeps legacy names parseable", () => {
		expect([...allToolNames]).toEqual(["rust", "bash"]);
		expect(Object.keys(createAllToolDefinitions(process.cwd()))).toEqual(["rust", "bash"]);
		expect(parseArgs(["--tools", "bash,edit,ipython"])).toMatchObject({
			tools: ["bash", "edit", "ipython"],
			diagnostics: [],
		});
	});

	it.each([
		{ name: "removed built-in names resolve to nothing", tools: ["edit"], factories: [], expected: [] },
		{
			name: "an extension tool may reuse a built-in name",
			tools: ["bash"],
			factories: [legacyBashExtension],
			expected: ["bash"],
		},
		{ name: "rust stays built in", tools: ["rust"], factories: [], expected: ["rust"] },
	])("$name", async ({ tools, factories, expected }) => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: factories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getCodingAgentFixtureModel("anthropic", "claude-sonnet-5"),
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			tools,
		});
		await session.bindExtensions({});

		try {
			expect(session.getAllTools().map((tool) => tool.name)).toEqual(expected);
			expect(session.getActiveToolNames()).toEqual(expected);
		} finally {
			session.dispose();
		}
	});

	it("applies shell settings to the bash built-in", async () => {
		const shellPath = join(tempDir, "custom-shell.sh");
		writeFileSync(shellPath, "#!/bin/sh\nprintf 'custom-shell\\n'\nexec /bin/sh \"$@\"\n");
		chmodSync(shellPath, 0o755);

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setShellCommandPrefix("echo prefix-from-settings");
		settingsManager.setShellPath(shellPath);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getCodingAgentFixtureModel("anthropic", "claude-sonnet-5"),
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			tools: ["bash"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(["bash"]);
			const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
			expect(bashTool).toBeTruthy();

			const result = await bashTool!.execute("tool-1", { command: "echo body" });
			const output = result.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("");

			expect(output).toContain("custom-shell\nprefix-from-settings\nbody");
		} finally {
			await session.disposeAsync();
		}
	});
});
