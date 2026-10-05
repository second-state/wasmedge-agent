/**
 * Bench driver (DESIGN.md §6.2–6.3): runs (task × model × group × rep)
 * headlessly against prime-agent and records everything needed for analyze.ts.
 *
 *   node poc/bench/run.ts --tasks 01-log-stats,03-fix-bug --groups F --reps 1
 *
 * Groups: A = stock upstream prime-agent (ipython baseline), B = upstream +
 * PoC rust extension (M1), F = this fork's built-in rust runtime (M5
 * acceptance; launched via the repo's own wasmedge-agent.sh, no extension).
 * Each run gets an isolated coding-agent dir (models.json copied in) so
 * sessions land in the run directory; the baseline kernel venv is shared to
 * avoid re-bootstrapping per run. Since the rebrand the two programs read
 * different env names -- upstream PRIME_AGENT_*, the fork WASMEDGE_AGENT_* --
 * so both are set and each binary ignores the other's.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentLauncher, launcherFields, launcherIdentity, resolveAgentLauncher, verifyAgentLauncher } from "./launchers.ts";
import { type SourceInput, loadSourceInputs, sameSourceInputs, sourceInputsIdentity, verifySourceInputs } from "./source-inputs.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const TASKS_DIR = join(HERE, "tasks");
const RESULTS_DIR = join(HERE, "results");
const PRIME_AGENT_SH = process.env.BENCH_PRIME_AGENT ?? "prime-agent";
const FORK_PRIME_AGENT = join(REPO, "wasmedge-agent.sh");
const EXTENSION_DIR = join(REPO, "poc", "extension");
const SHARED_KERNEL_VENV = join(homedir(), ".wasmedge-agent", "bench", "kernel-venv");
// The seed provider config is copied into every run's isolated agent dir, so
// either program's copy serves all groups; prefer this fork's, and fall back to
// upstream's for a machine that only has the stock install.
const FORK_MODELS_JSON = join(homedir(), ".wasmedge-agent", "models.json");
const MODELS_JSON = existsSync(FORK_MODELS_JSON)
	? FORK_MODELS_JSON
	: join(homedir(), ".prime", "agent", "models.json");

interface TaskSpec {
	id: string;
	category: string;
	turns: string[];
	timeoutMs?: number;
}

interface RunMeta extends AgentLauncher {
	sourceInputs: SourceInput[] | null;
	runId: string;
	planId: string;
	task: string;
	taskHash: string;
	providerConfigHash: string;
	category: string;
	group: "A" | "B" | "F";
	model: string;
	variant: string;
	rep: number;
	plannedAt: string;
	startedAt: string | null;
	wallMs: number | null;
	driverStatus: "planned" | "running" | "completed" | "error";
	driverError: string | null;
	daemonSocket: string | null;
	daemonPid: number | null;
	turnExitCodes: number[];
	timedOut: boolean;
	sessionFile: string | null;
	checkPass: boolean | null;
	checkOutput: string;
	runDir: string;
}

function parseArgs(argv: string[]) {
	const opts = {
		tasks: [] as string[],
		models: ["gateway/anthropic/claude-sonnet-4-6"],
		groups: ["A", "B"] as ("A" | "B" | "F")[],
		reps: 1,
		variant: "example" as "example" | "noexample" | "split",
		planOnly: false,
		sourceInputs: null as string | null,
		resumePlan: null as string | null,
	};
	if (argv.includes("--resume-plan")) {
		if (argv.length !== 2 || argv[0] !== "--resume-plan" || !isFileName(argv[1])) {
			throw new Error("use --resume-plan <planId> without run-selection options or --plan-only");
		}
		return { ...opts, resumePlan: argv[1] };
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
			return value;
		};
		if (arg === "--tasks") opts.tasks = next().split(",");
		else if (arg === "--models") opts.models = next().split(",");
		else if (arg === "--groups") opts.groups = next().split(",") as ("A" | "B" | "F")[];
		else if (arg === "--reps") opts.reps = Number(next());
		else if (arg === "--variant") opts.variant = next() as typeof opts.variant;
		else if (arg === "--source-inputs" && opts.sourceInputs === null) opts.sourceInputs = next();
		else if (arg === "--plan-only" && !opts.planOnly) opts.planOnly = true;
		else throw new Error(`unknown arg: ${arg}`);
	}
	if (opts.tasks.length === 0) {
		opts.tasks = readdirSync(TASKS_DIR).filter((name) =>
			existsSync(join(TASKS_DIR, name, "task.json")),
		);
		opts.tasks.sort();
	}
	if (!Number.isSafeInteger(opts.reps) || opts.reps < 1) throw new Error("--reps must be a positive safe integer");
	for (const [name, values] of [
		["tasks", opts.tasks], ["models", opts.models], ["groups", opts.groups],
	] as const) {
		if (!values.length || values.some((value) => !value.trim()) || new Set(values).size !== values.length) {
			throw new Error(`--${name} must contain distinct, nonempty values`);
		}
	}
	if (opts.groups.some((group) => !["A", "B", "F"].includes(group))) throw new Error("--groups must use A, B, or F");
	if (!["example", "noexample", "split"].includes(opts.variant)) throw new Error("invalid --variant");
	return opts;
}

function loadTask(id: string, taskDir = join(TASKS_DIR, id)): TaskSpec {
	const spec = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf-8")) as TaskSpec;
	if (
		!spec || typeof spec.category !== "string" || !spec.category.trim() ||
		!Array.isArray(spec.turns) || !spec.turns.length ||
		spec.turns.some((turn) => typeof turn !== "string" || !turn.trim()) ||
		(spec.timeoutMs !== undefined && (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0))
	) {
		throw new Error(`invalid task specification: ${id}`);
	}
	spec.id = id;
	return spec;
}

function hashTask(taskDir: string): string {
	const hash = createHash("sha256");
	const visit = (path: string, relative: string) => {
		const info = lstatSync(path);
		if (info.isDirectory()) {
			hash.update(JSON.stringify(["directory", relative]));
			for (const name of readdirSync(path).sort()) visit(join(path, name), relative ? `${relative}/${name}` : name);
		} else if (info.isFile()) {
			const bytes = readFileSync(path);
			hash.update(JSON.stringify(["file", relative, info.mode & 0o111, bytes.length]));
			hash.update(bytes);
		} else {
			throw new Error(`benchmark task inputs must be regular files or directories: ${path}`);
		}
	};
	visit(taskDir, "");
	return `sha256:${hash.digest("hex")}`;
}

function verifyTask(meta: RunMeta): void {
	if (hashTask(join(meta.runDir, "task")) !== meta.taskHash) {
		throw new Error("benchmark task inputs changed after planning");
	}
}

function hashProviderConfig(source: Buffer): string {
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function loadProviderConfig(): Buffer {
	if (!existsSync(MODELS_JSON)) throw new Error(`missing ${MODELS_JSON} (provider config)`);
	const source = readFileSync(MODELS_JSON);
	let config: unknown;
	try {
		// Match model-registry's line comments and trailing commas; retain the original bytes.
		const json = source.toString("utf-8")
			.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
			.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
		config = JSON.parse(json);
	} catch {
		// JSON parse errors can include literal credentials from the source.
		throw new Error("invalid provider config: expected a JSON object");
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("invalid provider config: expected a JSON object");
	}
	return source;
}

function verifyProviderConfig(meta: RunMeta, active = false): Buffer {
	const source = readFileSync(join(meta.runDir, "models.json"));
	if (
		hashProviderConfig(source) !== meta.providerConfigHash ||
		(active && hashProviderConfig(readFileSync(join(meta.runDir, "agent-dir", "models.json"))) !== meta.providerConfigHash)
	) {
		throw new Error("benchmark provider config changed after planning");
	}
	return source;
}

function shortModel(model: string): string {
	return model.split("/").pop() ?? model;
}

function runProcess(
	bin: string,
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; logFile: string },
): Promise<{ exitCode: number | null; timedOut: boolean }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(bin, args, {
			cwd: opts.cwd,
			env: opts.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let log = "";
		let timedOut = false;
		let spawnError: Error | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		}, opts.timeoutMs);
		const collect = (data: Buffer) => {
			log += data.toString("utf-8");
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("error", (err) => {
			clearTimeout(timer);
			spawnError = err;
			log += `\n${err.message}\n`;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			try {
				writeFileSync(opts.logFile, log);
			} catch (err) {
				rejectPromise(err);
				return;
			}
			if (spawnError) rejectPromise(spawnError);
			else resolvePromise({ exitCode: code, timedOut });
		});
	});
}

function findSessionFile(agentDir: string): string | null {
	const sessionsDir = join(agentDir, "sessions");
	if (!existsSync(sessionsDir)) return null;
	const files = readdirSync(sessionsDir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(sessionsDir, name))
		.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
	return files.at(-1) ?? null;
}

interface BenchDaemon {
	child: ChildProcess;
	closed: Promise<void>;
	exited: boolean;
	ready: boolean;
	error?: Error;
}

function launchDaemon(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string): BenchDaemon {
	const fd = openSync(logFile, "a");
	let child: ChildProcess;
	try {
		child = spawn(bin, ["--mode", "daemon", ...args], { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
	} finally {
		closeSync(fd);
	}
	const daemon: BenchDaemon = { child, exited: false, ready: false, closed: Promise.resolve() };
	child.once("error", (error) => {
		daemon.error = error;
		try {
			appendFileSync(logFile, `${error.message}\n`);
		} catch {
			// The launch error is also retained in run metadata.
		}
	});
	daemon.closed = new Promise((resolveClosed) => child.once("close", () => {
		daemon.exited = true;
		resolveClosed();
	}));
	return daemon;
}

function waitForDaemonHello(socketPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolveConnected, rejectConnected) => {
		const socket = createConnection(socketPath);
		let pending = "";
		let settled = false;
		const finish = (connected: boolean, error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) rejectConnected(error);
			else resolveConnected(connected);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		socket.setEncoding("utf-8");
		socket.on("data", (chunk: string) => {
			pending += chunk;
			if (pending.length > 128 * 1024) return finish(false, new Error("daemon handshake exceeds limit"));
			const newline = pending.indexOf("\n");
			if (newline === -1) return;
			try {
				const hello = JSON.parse(pending.slice(0, newline));
				if (hello?.type !== "daemon_hello" || hello.protocol?.name !== "prime-agent.daemon" || hello.protocol.version !== 7) {
					return finish(false, new Error("unsupported benchmark daemon protocol (requires version 7)"));
				}
				finish(true);
			} catch {
				finish(false, new Error("invalid benchmark daemon handshake"));
			}
		});
		socket.once("error", () => finish(false));
		socket.once("close", () => finish(false));
	});
}

async function waitForDaemon(daemon: BenchDaemon, socketPath: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!daemon.exited && Date.now() < deadline) {
		// A listening socket can precede catalog initialization; only the hello confirms readiness.
		if (await waitForDaemonHello(socketPath, deadline - Date.now())) {
			daemon.ready = true;
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	throw daemon.error ?? new Error(daemon.exited ? "benchmark daemon exited before readiness" : "benchmark daemon startup timed out");
}

function waitForDaemonExit(daemon: BenchDaemon, timeoutMs: number): Promise<boolean> {
	return new Promise((resolveExited) => {
		const timer = setTimeout(() => resolveExited(false), timeoutMs);
		void daemon.closed.then(() => {
			clearTimeout(timer);
			resolveExited(true);
		});
	});
}

function requestDaemonShutdown(socketPath: string): Promise<void> {
	return new Promise((resolveShutdown, rejectShutdown) => {
		const socket = createConnection(socketPath);
		let pending = "";
		let settled = false;
		let requested = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) rejectShutdown(error);
			else resolveShutdown();
		};
		const timer = setTimeout(() => finish(new Error("daemon shutdown request timed out")), 2_000);
		socket.setEncoding("utf-8");
		socket.on("data", (chunk: string) => {
			pending += chunk;
			if (pending.length > 128 * 1024) return finish(new Error("daemon shutdown response exceeds limit"));
			let newline: number;
			while ((newline = pending.indexOf("\n")) !== -1) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				try {
					const message = JSON.parse(line);
					const response = message?.type === "event" ? message.event : message;
					if (response?.type === "daemon_hello" && !requested) {
						if (response.protocol?.name !== "prime-agent.daemon" || response.protocol.version !== 7) {
							return finish(new Error("unsupported benchmark daemon protocol (requires version 7)"));
						}
						requested = true;
						socket.write(`${JSON.stringify({
							type: "command", id: "bench-shutdown", protocol: response.protocol,
							command: { type: "shutdown", force: true },
						})}\n`);
					}
					if (response?.type === "response" && response.id === "bench-shutdown") {
						finish(response.success === true ? undefined : new Error(`daemon rejected shutdown: ${String(response.error ?? "unknown error")}`));
						return;
					}
				} catch {
					return finish(new Error("invalid daemon shutdown response"));
				}
			}
		});
		socket.once("error", finish);
		socket.once("close", () => finish(new Error("daemon closed before acknowledging shutdown")));
	});
}

async function stopDaemon(daemon: BenchDaemon, socketPath: string): Promise<void> {
	if (daemon.exited || daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
		if (daemon.ready) throw new Error("benchmark daemon exited unexpectedly; socket directory retained for inspection");
		return;
	}
	let shutdownError: Error | undefined;
	if (daemon.ready) {
		try {
			// The protocol shutdown stops detached workers too; SIGTERM alone preserves them for recovery.
			await requestDaemonShutdown(socketPath);
			if (await waitForDaemonExit(daemon, 10_000)) {
				if (daemon.child.exitCode !== 0) throw new Error("benchmark daemon failed during shutdown");
				return;
			}
			shutdownError = new Error("benchmark daemon did not exit after shutdown");
		} catch (error) {
			shutdownError = error instanceof Error ? error : new Error(String(error));
		}
	}
	// These groups were created by launchDaemon. No host process discovery is used.
	if (!daemon.exited && daemon.child.pid) process.kill(-daemon.child.pid, "SIGTERM");
	if (await waitForDaemonExit(daemon, 1_000)) {
		if (shutdownError) throw shutdownError;
		return;
	}
	if (!daemon.exited && daemon.child.pid) process.kill(-daemon.child.pid, "SIGKILL");
	if (!(await waitForDaemonExit(daemon, 1_000))) daemon.child.unref();
	throw new Error("benchmark daemon did not stop gracefully; inspect daemon.log and the recorded socket directory");
}

function planRun(
	task: TaskSpec,
	group: "A" | "B" | "F",
	model: string,
	variant: string,
	rep: number,
	providerConfig: Buffer,
	planId: string,
	launcher: AgentLauncher,
	sourceInputs: SourceInput[] | null,
): { task: TaskSpec; meta: RunMeta } {
	const variantSlug = variant.replace(/[^a-z0-9]+/gi, "") || "default";
	const runId = `${task.id}-${group}-${shortModel(model)}-${variantSlug}-r${rep}-${randomUUID()}`;
	const runDir = join(RESULTS_DIR, "runs", runId);
	mkdirSync(runDir, { mode: 0o700 });
	writeFileSync(join(runDir, "models.json"), providerConfig, { mode: 0o600 });
	const taskDir = join(runDir, "task");
	cpSync(join(TASKS_DIR, task.id), taskDir, { recursive: true, verbatimSymlinks: true });
	const taskHash = hashTask(taskDir);
	const snapshot = loadTask(task.id, taskDir);
	const meta: RunMeta = {
		...launcher,
		sourceInputs,
		runId,
		planId,
		task: task.id,
		taskHash,
		providerConfigHash: hashProviderConfig(providerConfig),
		category: snapshot.category,
		group,
		model,
		variant,
		rep,
		plannedAt: new Date().toISOString(),
		startedAt: null,
		wallMs: null,
		driverStatus: "planned",
		driverError: null,
		daemonSocket: null,
		daemonPid: null,
		turnExitCodes: [],
		timedOut: false,
		sessionFile: null,
		checkPass: null,
		checkOutput: "",
		runDir,
	};
	persistMeta(meta);
	return { task: snapshot, meta };
}

async function runOne(task: TaskSpec, meta: RunMeta): Promise<RunMeta> {
	const { runDir, group, model, variant } = meta;
	const taskDir = join(runDir, "task");
	const projectDir = join(runDir, "project");
	const agentDir = join(runDir, "agent-dir");
	meta.startedAt = new Date().toISOString();
	meta.driverStatus = "running";
	persistMeta(meta);
	let turnStartedAt: number | null = null;
	let turnsFinished = false;
	let daemon: BenchDaemon | undefined;
	let socketDir: string | undefined;
	let cleanupPromise: Promise<void> | undefined;
	const cleanupDaemon = () => cleanupPromise ??= (async () => {
		if (daemon && meta.daemonSocket) await stopDaemon(daemon, meta.daemonSocket);
		if (socketDir) rmSync(socketDir, { recursive: true, force: true });
	})();
	try {
		verifyTask(meta);
		const providerConfig = verifyProviderConfig(meta);
		verifyAgentLauncher(meta);
		verifySourceInputs(meta.sourceInputs);
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const fixtureDir = join(taskDir, "fixture");
		if (existsSync(fixtureDir)) cpSync(fixtureDir, projectDir, { recursive: true });
		writeFileSync(join(agentDir, "models.json"), providerConfig, { mode: 0o600 });

		const env: NodeJS.ProcessEnv = {
			...process.env,
			// Upstream (groups A and B) reads these...
			PRIME_AGENT_CODING_AGENT_DIR: agentDir,
			PRIME_AGENT_KERNEL_VENV: SHARED_KERNEL_VENV,
			// ...and this fork (group F) reads these. Each ignores the other's.
			WASMEDGE_AGENT_CODING_AGENT_DIR: agentDir,
			WASMEDGE_AGENT_KERNEL_VENV: SHARED_KERNEL_VENV,
		};
		if (group === "B") {
			env.WASMEDGE_POC_PROMPT = variant;
			env.WASMEDGE_POC_WORKSPACE_ROOT = join(runDir, "workspaces");
		}

		// POSIX socket and worker-socket paths must stay short, even when the results directory is deeply nested.
		socketDir = mkdtempSync("/tmp/wasmedge-bench-");
		meta.daemonSocket = join(socketDir, "daemon.sock");
		persistMeta(meta);
		const baseArgs = ["--model", model, "--daemon-socket", meta.daemonSocket];
		if (group === "B") baseArgs.push("--no-builtin-tools", "-e", EXTENSION_DIR);
		// F: the fork's own CLI with its built-in rust runtime — no extension,
		// prompt variant is whatever the fork ships (D17: example is the default).
		const bin = meta.launcherPath;

		const timeoutMs = task.timeoutMs ?? 600_000;
		verifyProviderConfig(meta, true);
		verifyAgentLauncher(meta);
		verifySourceInputs(meta.sourceInputs);
		turnStartedAt = Date.now();
		daemon = launchDaemon(bin, baseArgs, projectDir, env, join(runDir, "daemon.log"));
		meta.daemonPid = daemon.child.pid ?? null;
		persistMeta(meta);
		await waitForDaemon(daemon, meta.daemonSocket, Math.min(timeoutMs, 30_000));

		for (let turn = 0; turn < task.turns.length; turn++) {
			verifyProviderConfig(meta, true);
			verifyAgentLauncher(meta);
			verifySourceInputs(meta.sourceInputs);
			if (daemon.exited) throw new Error("benchmark daemon exited before the next turn");
			const args = [...baseArgs];
			if (turn > 0) {
				// Bare --resume is interactive-only; headless requires the explicit path.
				const sessionFile = findSessionFile(agentDir);
				if (!sessionFile) throw new Error(`turn ${turn}: no session file to resume in ${agentDir}`);
				args.push("--resume", sessionFile);
			}
			args.push("--print", task.turns[turn]);
			const result = await runProcess(bin, args, {
				cwd: projectDir,
				env,
				timeoutMs,
				logFile: join(runDir, `turn-${turn}.log`),
			});
			meta.turnExitCodes.push(result.exitCode ?? -1);
			meta.timedOut = result.timedOut;
			meta.wallMs = Date.now() - turnStartedAt;
			meta.sessionFile = findSessionFile(agentDir);
			persistMeta(meta);
			verifyProviderConfig(meta, true);
			verifyAgentLauncher(meta);
			verifySourceInputs(meta.sourceInputs);
			if (result.timedOut) {
				break;
			}
		}
		meta.wallMs = Date.now() - turnStartedAt;
		turnsFinished = true;
		persistMeta(meta);
		await cleanupDaemon();

		verifyTask(meta);
		verifyProviderConfig(meta, true);
		verifyAgentLauncher(meta);
		verifySourceInputs(meta.sourceInputs);
		const checkScript = join(taskDir, "check.sh");
		if (existsSync(checkScript)) {
			const check = await new Promise<{ code: number | null; out: string }>((res, reject) => {
				const child = spawn("bash", [checkScript], {
					cwd: taskDir,
					env: { ...process.env, PROJECT_DIR: projectDir },
					stdio: ["ignore", "pipe", "pipe"],
				});
				let out = "";
				child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
				child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
				child.on("close", (code) => res({ code, out }));
				child.on("error", reject);
			});
			meta.checkPass = check.code === 0;
			meta.checkOutput = check.out.slice(0, 4000);
		}
		verifyTask(meta);
		verifyProviderConfig(meta, true);
		verifyAgentLauncher(meta);
		verifySourceInputs(meta.sourceInputs);
		meta.sessionFile = findSessionFile(agentDir);
		meta.driverStatus = "completed";
	} catch (err) {
		meta.driverStatus = "error";
		meta.driverError = err instanceof Error ? err.message : String(err);
		meta.checkPass = null;
		if (turnStartedAt !== null && !turnsFinished) meta.wallMs = Date.now() - turnStartedAt;
		try {
			meta.sessionFile = findSessionFile(agentDir);
		} catch {
			// Preserve the last checkpoint if session discovery also fails.
		}
	} finally {
		try {
			await cleanupDaemon();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			meta.driverStatus = "error";
			if (!meta.driverError?.includes(message)) meta.driverError = [meta.driverError, message].filter(Boolean).join("; ");
			meta.checkPass = null;
		}
	}
	persistMeta(meta);
	return meta;
}

function persistMeta(meta: RunMeta): void {
	const path = join(meta.runDir, "meta.json");
	// An interrupted rewrite must leave the previous complete JSON document.
	writeFileSync(`${path}.tmp`, JSON.stringify(meta, null, 2));
	renameSync(`${path}.tmp`, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." &&
		!value.startsWith("--") && !/[\\/\0]/.test(value);
}

function readRecord(path: string): Record<string, unknown> {
	try {
		if (!lstatSync(path).isFile()) throw new Error("not a regular file");
		const record: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (isRecord(record)) return record;
	} catch {
		// Do not include JSON parse errors, which can expose stored content.
	}
	throw new Error(`invalid or missing benchmark record: ${path}`);
}

function lockPlan(planId: string): () => void {
	const locksDir = join(RESULTS_DIR, "locks");
	mkdirSync(locksDir, { recursive: true, mode: 0o700 });
	const path = join(locksDir, `${planId}.lock`);
	const owner = JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), token: randomUUID() });
	try {
		writeFileSync(path, owner, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (isRecord(error) && error.code === "EEXIST") {
			throw new Error(`benchmark plan is locked: ${path}; inspect the owner and any leftover processes before removing a stale lock`);
		}
		throw error;
	}
	return () => {
		// Do not remove a replacement lock if an operator removed ours while active.
		if (existsSync(path) && readFileSync(path, "utf-8") === owner) rmSync(path);
	};
}

function resumePlan(planId: string): { task: TaskSpec; meta: RunMeta }[] {
	const manifest = readRecord(join(RESULTS_DIR, "plans", `${planId}.json`));
	if (manifest.version !== 1 || manifest.planId !== planId || !Array.isArray(manifest.runs) || !manifest.runs.length) {
		throw new Error(`invalid benchmark plan: ${planId}`);
	}
	if (manifest.executionLockVersion !== 1) {
		throw new Error(`benchmark plan predates execution locking and cannot be resumed: ${planId}`);
	}
	if (manifest.launcherPinVersion !== 1) {
		throw new Error(`benchmark plan has no supported agent launcher pin and cannot be resumed: ${planId}`);
	}
	if (manifest.sourcePinVersion !== undefined && manifest.sourcePinVersion !== 1 ||
		manifest.runs.some((slot) => !isRecord(slot) || (manifest.sourcePinVersion === 1
			? slot.sourceInputs !== null && !sourceInputsIdentity(slot.sourceInputs)
			: slot.sourceInputs !== undefined))) {
		throw new Error(`invalid benchmark source-input pins in plan: ${planId}`);
	}
	const ids = new Set<string>();
	const slots = new Set<string>();
	const pending: { task: TaskSpec; meta: RunMeta }[] = [];
	const fields = ["runId", "task", "taskHash", "providerConfigHash", "model", "group", "variant", "rep", ...launcherFields] as const;
	for (const slot of manifest.runs) {
		if (!isRecord(slot) || !isFileName(slot.runId) || !launcherIdentity(slot) ||
			!["task", "model"].every((key) => typeof slot[key] === "string" && slot[key].trim()) ||
			!["taskHash", "providerConfigHash"].every((key) => typeof slot[key] === "string" && /^sha256:[a-f0-9]{64}$/.test(slot[key])) ||
			typeof slot.rep !== "number" || !Number.isSafeInteger(slot.rep) || slot.rep < 1 || typeof slot.variant !== "string" ||
			!(slot.group === "A" && slot.variant === "n/a" || slot.group === "F" && slot.variant === "builtin" ||
				slot.group === "B" && ["example", "noexample"].includes(slot.variant))) {
			throw new Error(`invalid slot in benchmark plan: ${planId}`);
		}
		const key = JSON.stringify([slot.task, slot.model, slot.group, slot.variant, slot.rep]);
		if (ids.has(slot.runId) || slots.has(key)) throw new Error(`duplicate slot in benchmark plan: ${slot.runId}`);
		ids.add(slot.runId);
		slots.add(key);
		const runDir = join(RESULTS_DIR, "runs", slot.runId);
		if (!lstatSync(runDir).isDirectory()) throw new Error(`invalid benchmark run directory: ${runDir}`);
		const record = readRecord(join(runDir, "meta.json"));
		if (record.planId !== planId || record.runDir !== runDir || fields.some((key) => record[key] !== slot[key]) ||
			!sameSourceInputs(record.sourceInputs, slot.sourceInputs) ||
			typeof record.driverStatus !== "string" || !["planned", "running", "completed", "error"].includes(record.driverStatus)) {
			throw new Error(`run record differs from benchmark plan: ${slot.runId}`);
		}
		if (record.driverStatus !== "planned") {
			console.log(`skip ${slot.runId}: ${record.driverStatus} (not retried)`);
			if (record.driverStatus !== "completed") process.exitCode = 1;
			continue;
		}
		if (!["startedAt", "wallMs", "driverError", "daemonSocket", "daemonPid", "sessionFile", "checkPass"].every((key) => record[key] === null) ||
			!Array.isArray(record.turnExitCodes) || record.turnExitCodes.length !== 0 || record.timedOut !== false || record.checkOutput !== "" ||
			readdirSync(runDir).some((name) => !["meta.json", "task", "models.json"].includes(name))) {
			throw new Error(`planned benchmark run contains execution evidence: ${slot.runId}`);
		}
		const meta = record as unknown as RunMeta;
		verifyTask(meta);
		verifyProviderConfig(meta);
		verifyAgentLauncher(meta);
		verifySourceInputs(meta.sourceInputs);
		const task = loadTask(meta.task, join(runDir, "task"));
		if (meta.category !== task.category) throw new Error(`task category differs from snapshot: ${slot.runId}`);
		pending.push({ task, meta });
	}
	return pending;
}

function createPlan(opts: ReturnType<typeof parseArgs>, planId: string): { task: TaskSpec; meta: RunMeta }[] {
	// Validate the full selection and persist every slot before any agent can run.
	const tasks = opts.tasks.map((id) => loadTask(id));
	const providerConfig = loadProviderConfig();
	const sources = loadSourceInputs(opts.sourceInputs, opts.groups, RESULTS_DIR);
	const launchers = new Map(opts.groups.map((group) =>
		[group, resolveAgentLauncher(group === "F" ? FORK_PRIME_AGENT : PRIME_AGENT_SH)]));
	console.log(
		`bench: ${opts.tasks.length} task(s) × ${opts.groups.join("+")} × ${opts.models.length} model(s) × ${opts.reps} rep(s), variant=${opts.variant}`,
	);
	mkdirSync(join(RESULTS_DIR, "runs"), { recursive: true });

	const plan: { task: TaskSpec; meta: RunMeta }[] = [];
	for (const task of tasks) {
		for (const model of opts.models) {
			for (const group of opts.groups) {
				for (let rep = 1; rep <= opts.reps; rep++) {
					// D17 split: alternate prompt variants across reps for group B.
					const variant =
						group === "A" || group === "F"
							? group === "F"
								? "builtin"
								: "n/a"
							: opts.variant === "split"
								? rep % 2 === 1
									? "example"
									: "noexample"
								: opts.variant;
					plan.push(planRun(task, group, model, variant, rep, providerConfig, planId, launchers.get(group)!, sources.get(group)!));
				}
			}
		}
	}
	// Keep the expected inventory outside individual run directories so deleted
	// records cannot silently shrink the comparison after execution.
	const plansDir = join(RESULTS_DIR, "plans");
	mkdirSync(plansDir, { recursive: true });
	const planPath = join(plansDir, `${planId}.json`);
	writeFileSync(`${planPath}.tmp`, JSON.stringify({
		version: 1,
		executionLockVersion: 1,
		launcherPinVersion: 1,
		sourcePinVersion: 1,
		planId,
		plannedAt: new Date().toISOString(),
		runs: plan.map(({ meta }) => ({
			runId: meta.runId,
			task: meta.task,
			taskHash: meta.taskHash,
			providerConfigHash: meta.providerConfigHash,
			launcherPath: meta.launcherPath,
			launcherRealPath: meta.launcherRealPath,
			launcherHash: meta.launcherHash,
			sourceInputs: meta.sourceInputs,
			model: meta.model,
			group: meta.group,
			variant: meta.variant,
			rep: meta.rep,
		})),
	}, null, 2), { flag: "wx", mode: 0o600 });
	renameSync(`${planPath}.tmp`, planPath);
	return plan;
}

const opts = parseArgs(process.argv.slice(2));
const planId = opts.resumePlan ?? randomUUID();
const unlock = lockPlan(planId);
try {
	const plan = opts.resumePlan ? resumePlan(planId) : createPlan(opts, planId);
	console.log(`plan: ${planId}; ${plan.length} run(s) ${opts.planOnly ? "saved without execution" : "to execute"}`);
	if (!opts.planOnly) {
		const failures: string[] = [];
		let done = 0;
		for (const { task, meta } of plan) {
			const label = `${task.id} ${meta.group} ${shortModel(meta.model)} ${meta.variant} r${meta.rep}`;
			process.stdout.write(`→ ${label} ... `);
			try {
				await runOne(task, meta);
				if (meta.driverStatus === "error") {
					console.log(`DRIVER-ERROR: ${meta.driverError}`);
					failures.push(label);
					process.exitCode = 1;
					continue;
				}
				done += 1;
				const status = meta.timedOut
					? "TIMEOUT"
					: meta.checkPass === null
						? "no-check"
						: meta.checkPass
							? "PASS"
							: "FAIL";
				console.log(`${status} (${Math.round((meta.wallMs ?? 0) / 1000)}s)`);
				if (status === "FAIL" || status === "TIMEOUT") failures.push(label);
			} catch (err) {
				console.log(`DRIVER-ERROR: ${err instanceof Error ? err.message : err}`);
				failures.push(label);
				process.exitCode = 1;
			}
		}
		console.log(`\n${done} run(s) complete. ${failures.length} failure(s).`);
		if (failures.length > 0) for (const f of failures) console.log(`  failed: ${f}`);
		console.log(`analyze with: node poc/bench/analyze.ts`);
	}
} finally {
	unlock();
}
