// One private stdio connection per native tool call. Closing stdin cancels
// the call even when the client or its daemon worker exits unexpectedly.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runStorageCommand } from "./cli/storage.js";
import { AuthStorage } from "./core/auth-storage.js";
import type { HostRequestHandlers } from "./core/host-bridge/types.js";
import { McpManager } from "./core/mcp/mcp-manager.js";
import { createHarnessHostHandler } from "./core/refinement/harness-api.js";
import { getGlobalHarnessStateDir, getLocalHarnessStateDir } from "./core/refinement/refinement.js";
import { resolveConfigValue } from "./core/resolve-config-value.js";
import { collectRuntimeChecks, fixRuntime } from "./core/rust-cell/doctor.js";
import { RustCellProvisioner } from "./core/rust-cell/index.js";
import { openProcessTree } from "./core/rust-cell/process-tree.js";
import { snapshotWorkspace, WORKSPACE_SEED_DIR } from "./core/rust-cell/workspace-snapshot.js";
import { SettingsManager } from "./core/settings-manager.js";
import { createSkillPackageHostHandler } from "./core/skill-package.js";
import { getRustSkillRuntimeInfo, loadSkills } from "./core/skills.js";
import { createBashTool } from "./core/tools/bash.js";
import { createRustTool, type RustToolInput } from "./core/tools/rust.js";
import { SERPER_CREDENTIAL_ID, SERPER_ENV_VAR } from "./core/websearch-credential.js";
import { createWebsearchHostHandler } from "./core/websearch-host.js";

interface Session {
	cwd: string;
	agentDir: string;
	artifactDir: string;
	persistent: boolean;
	depth: number;
	sessionDir: string;
	treeId: string;
	skills: string[];
	handlers: string[];
}

type Call = { id: string; session: Session } & (
	| { tool: "rust"; args: RustToolInput }
	| { tool: "bash"; args: Parameters<ReturnType<typeof createBashTool>["execute"]>[1] }
);

interface Reply {
	id: number;
	value?: Record<string, unknown>;
	error?: string;
}

function send(frame: object): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function main(): Promise<void> {
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	const lifetime = new AbortController();
	const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(reason: Error): void }>();
	let sequence = 0;
	let running: Promise<void> | undefined;
	function abort() {
		lifetime.abort();
		for (const handler of pending.values()) handler.reject(new Error("Tool host disconnected"));
		pending.clear();
	}
	async function run({ session, tool, id, args }: Call): Promise<void> {
		const { cwd, agentDir, artifactDir } = session;
		const settings = SettingsManager.create(cwd, agentDir);
		const stream = (update: unknown) => send({ event: "update", update });
		if (tool === "bash") {
			const bash = createBashTool(cwd, {
				shellPath: settings.getShellPath(),
				commandPrefix: settings.getShellCommandPrefix(),
			});
			const result = await bash.execute(id, args, lifetime.signal, stream);
			send({ event: "result", result });
			return;
		}
		if (tool !== "rust") throw new Error("Unknown native tool");
		const skills = loadSkills({ cwd, agentDir, skillPaths: session.skills, includeDefaults: false }).skills;
		let provisioner: RustCellProvisioner;
		const handlers: HostRequestHandlers = Object.create(null);
		for (const type of session.handlers) {
			handlers[type] = (payload, context) =>
				new Promise((resolve, reject) => {
					const requestId = ++sequence;
					const signal = context?.signal ?? lifetime.signal;
					signal.throwIfAborted();
					const cancel = () => {
						pending.delete(requestId);
						send({ event: "cancelRequest", id: requestId });
						reject(new Error("Guest host request cancelled"));
					};
					signal.addEventListener("abort", cancel, { once: true });
					pending.set(requestId, {
						resolve: (value) => {
							signal.removeEventListener("abort", cancel);
							resolve(value);
						},
						reject: (error) => {
							signal.removeEventListener("abort", cancel);
							reject(error);
						},
					});
					send({ event: "request", id: requestId, type, payload });
				});
		}
		const local = getLocalHarnessStateDir(session.persistent ? artifactDir : undefined);
		const global = getGlobalHarnessStateDir(agentDir);
		const auth = AuthStorage.create(join(agentDir, "auth.json"));
		handlers["websearch.run"] = createWebsearchHostHandler({
			resolveApiKey: () => {
				const stored = auth.get(SERPER_CREDENTIAL_ID);
				return (
					process.env[SERPER_ENV_VAR]?.trim() ||
					(stored?.type === "api_key" ? resolveConfigValue(stored.key) : undefined)
				);
			},
		});
		handlers["skills.package"] = createSkillPackageHostHandler({
			cwd,
			existingNames: () => skills.map((s) => s.name),
		});
		handlers["harness.request"] = createHarnessHostHandler({
			resolveDirectory: (scope) => (scope === "local" ? local : global),
			testSkill: (reference, signal) => provisioner.testSkill(reference, signal),
		});
		handlers["harness.skill.test"] = async ({ reference }, context) => {
			if (!reference || typeof reference !== "object" || Array.isArray(reference))
				throw new Error("Expected a Rust skill reference");
			await provisioner.testSkill(reference as Record<string, unknown>, context?.signal);
			return { passed: true };
		};
		const mcp = new McpManager({ authStorage: auth, getUserServers: () => settings.getGlobalMcpServers() });
		const mcpHandlers = mcp.hostHandlers();
		handlers["mcp.list_tools"] = mcpHandlers["mcp.list_tools"];
		handlers["mcp.call_tool"] = mcpHandlers["mcp.call_tool"];
		const treeLimits = settings.getRustCellTreeProcessLimits();
		const tree = treeLimits ? await openProcessTree(agentDir, session.treeId, treeLimits) : undefined;
		const seed = join(session.sessionDir, WORKSPACE_SEED_DIR);
		try {
			provisioner = new RustCellProvisioner({
				processGroup: tree?.group,
				cwd,
				workspaceDir: join(artifactDir, "workspace"),
				initialWorkspaceDir: existsSync(seed) ? seed : undefined,
				cellTimeoutMs: settings.getRustCellTimeoutMs(),
				runtimeMode: settings.getRustCellRuntimeMode(),
				cargoSandbox: settings.getRustCellCargoSandbox(),
				libraryTestGate: settings.getRustCellLibraryTestGate(),
				workspaceWritePolicy: settings.getRustCellWorkspaceWritePolicy(),
				rustdocToolchain: settings.getRustCellRustdocToolchain(),
				preludeExtra: settings.getRustCellPreludeExtra(),
				...settings.getRustCellResourceLimits(),
				rustSkills: getRustSkillRuntimeInfo(skills),
				hostHandlers: handlers,
				harnessDir: local,
				globalHarnessDir: global,
				cellEnv: { RLM_DEPTH: String(session.depth), RLM_MAX_DEPTH: process.env.RLM_MAX_DEPTH ?? "8" },
				onDiagnostic: (message) => process.stderr.write(`${message}\n`),
			});

			try {
				const result = await createRustTool(cwd, { provisioner }).execute(id, args, lifetime.signal, stream);
				send({ event: "result", result });
			} finally {
				await provisioner.dispose();
			}
		} finally {
			try {
				await mcp.dispose();
			} finally {
				await tree?.close();
			}
		}
	}
	input.on("line", (line) => {
		try {
			if (!running) {
				running = run(JSON.parse(line) as Call)
					.catch((error: unknown) => {
						send({ event: "error", message: String(error) });
					})
					.finally(() => {
						input.close();
						process.stdin.destroy();
					});
				return;
			}
			const reply = JSON.parse(line) as Reply;
			const handler = pending.get(reply.id);
			if (!handler) return;
			pending.delete(reply.id);
			if (reply.error !== undefined) handler.reject(new Error(reply.error));
			else handler.resolve(reply.value ?? {});
		} catch (error) {
			abort();
			send({ event: "error", message: String(error) });
			input.close();
		}
	});
	await new Promise<void>((resolve) => input.once("close", resolve));
	abort();
	await running;
}

async function dispatch(): Promise<void> {
	if (process.argv[2] === "--storage") return runStorageCommand(process.argv.slice(3));
	if (process.argv[2] === "--bootstrap" || process.argv[2] === "--runtime-check") {
		const bootstrap = process.argv[2] === "--bootstrap";
		const fixes = bootstrap || process.argv.includes("--fix") ? fixRuntime() : undefined;
		const runtime = collectRuntimeChecks();
		send({ runtime, fixes });
		if (bootstrap && runtime.some((check) => !check.ok)) process.exitCode = 1;
		return;
	}
	if (process.argv[2] === "--snapshot") {
		const [artifacts, sessionDir, destination] = process.argv.slice(3);
		const source = [join(artifacts, "workspace"), join(sessionDir, WORKSPACE_SEED_DIR)].find((dir) =>
			existsSync(join(dir, "Cargo.toml")),
		);
		if (source) {
			const controller = new AbortController();
			process.stdin.once("end", () => controller.abort());
			process.stdin.resume();
			try {
				await snapshotWorkspace(source, join(destination, WORKSPACE_SEED_DIR), { signal: controller.signal });
			} finally {
				process.stdin.destroy();
			}
		}
		return;
	}
	await main();
}

dispatch().catch((error: unknown) => {
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
});
