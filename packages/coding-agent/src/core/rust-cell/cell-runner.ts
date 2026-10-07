/** The cell execution pipeline: apply lib files -> cargo build -> wasmedge run
 * -> structured result. DESIGN.md §2.3–§2.5. */

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBuildPermit } from "./build-gate.js";
import { cargoArtifactPath, cargoCommand, cargoTargetDir, normalizeCargoSandbox } from "./cargo-sandbox.js";
import { CellTimer } from "./cell-timing.js";
import { assertHarnessMountsIsolated, assertReadonlyWorkspaceMounts } from "./harness-mounts.js";
import { normalizeLibraryTestGate, testLibraryEdits } from "./library-tests.js";
import { type ProcOutcome, runProcess } from "./process.js";
import { runtimeProcessLimits } from "./process-limits.js";
import { wasmedgeResourceArgs } from "./resource-limits.js";
import { type CellInput, type CellResult, type PerCallOptions, type RunnerOptions, truncate } from "./types.js";
import { validateWasiImports } from "./wasm-imports.js";
import { type AppliedLib, applyLib, createScratchDir, ensureStateDir, revertLib } from "./workspace.js";
import { normalizeWorkspaceWritePolicy } from "./workspace-policy.js";

const ANSI = /\x1b\[[0-9;]*m/g;
// (module (func (export "_start"))) — no imports, memory, or side effects.
const PREOPEN_PROBE = Buffer.from("0061736d0100000001040160000003020100070a01065f737461727400000a040102000b", "hex");

/** Extract human-readable diagnostics from `--message-format=json` output. */
function renderedDiagnostics(cargoStdout: string, cargoStderr: string): string {
	const rendered: string[] = [];
	for (const line of cargoStdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const msg = JSON.parse(line);
			if (msg.reason === "compiler-message" && typeof msg.message?.rendered === "string") {
				rendered.push(msg.message.rendered);
			}
		} catch {
			// non-JSON line: ignore
		}
	}
	const text = rendered.join("").replace(ANSI, "");
	// Fall back to raw stderr (e.g. manifest errors never reach compiler-message).
	return text.trim() ? text : cargoStderr.replace(ANSI, "");
}

export class CellRunner {
	private queue: Promise<unknown> = Promise.resolve();
	private readonly shutdown = new AbortController();
	private mountLibReadonly = true;
	private probed = false;
	private readonly opts: RunnerOptions;
	private readonly resourceArgs: string[];

	constructor(opts: RunnerOptions) {
		this.resourceArgs = wasmedgeResourceArgs(opts);
		this.opts = {
			...opts,
			cargoSandbox: normalizeCargoSandbox(opts.cargoSandbox),
			processLimits: runtimeProcessLimits(opts.processLimits, opts.cargoSandbox),
			workspaceWritePolicy: normalizeWorkspaceWritePolicy(opts.workspaceWritePolicy),
			libraryTestGate: normalizeLibraryTestGate(opts.libraryTestGate),
		};
	}

	/** Serialize cells (executionMode "sequential" is also enforced host-side). */
	execute(input: CellInput, per: PerCallOptions = {}): Promise<CellResult> {
		const queuedAt = performance.now();
		const submitted = { code: input.code, lib: input.lib?.map((file) => ({ ...file })) };
		const run = this.queue.then(async () => {
			const timer = new CellTimer();
			const result = await this.executeInner(submitted, per, timer);
			return Object.assign(result, timer.finish(timer.started - queuedAt));
		});
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** Cancel active and queued cells, then wait for rollback and bridge cleanup. */
	async dispose(): Promise<void> {
		this.shutdown.abort(new Error("cell runner disposed"));
		await this.queue;
	}

	private async executeInner(input: CellInput, per: PerCallOptions, timer: CellTimer): Promise<CellResult> {
		const started = timer.started;
		const cellId = per.cellId ?? `cell-${randomBytes(6).toString("hex")}`;
		const deadline = AbortSignal.timeout(this.opts.cellTimeoutMs);
		const signal = AbortSignal.any([this.shutdown.signal, deadline, ...(per.signal ? [per.signal] : [])]);
		const remainingMs = () => Math.max(0, Math.floor(this.opts.cellTimeoutMs - (performance.now() - started)));
		const interruptedStatus = () => (this.shutdown.signal.aborted || per.signal?.aborted ? "aborted" : "timeout");
		if (signal.aborted) {
			return this.result(interruptedStatus(), {
				started,
				compileMs: 0,
				runMs: 0,
				libApplied: false,
				libReverted: false,
				stderr: "cell was cancelled before execution",
			});
		}
		const ws = this.opts.workspaceDir;
		const prepared = timer.start("prepareMs");
		this.checkMounts();
		ensureStateDir(ws);
		prepared();
		try {
			if (this.opts.validateSkills) {
				await timer.measure("skillValidationMs", () => this.opts.validateSkills!(signal, remainingMs()));
			}
			signal.throwIfAborted();
			if (this.opts.libraryTestGate && input.lib?.length) {
				await timer.measure("libraryTestsMs", () =>
					testLibraryEdits(input.lib!, { ...this.opts, timeoutMs: Math.max(0, remainingMs()), signal }),
				);
				signal.throwIfAborted();
			}
		} catch (error) {
			return this.result(signal.aborted ? interruptedStatus() : "error", {
				started,
				compileMs: 0,
				runMs: 0,
				libApplied: false,
				libReverted: false,
				stderr: truncate(`cell did not run: ${error instanceof Error ? error.message : String(error)}`),
			});
		}

		let applied: AppliedLib | undefined;
		let libApplied = false;
		const mainPath = join(ws, "cell", "src", "main.rs");
		const sourcesPrepared = timer.start("prepareMs");
		const previousMain = existsSync(mainPath) ? readFileSync(mainPath, "utf-8") : null;
		let mainWritten = false;
		let buildSucceeded = false;
		let compileStarted = performance.now();
		let build: ProcOutcome;
		try {
			if (input.lib && input.lib.length > 0) {
				applied = applyLib(ws, input.lib);
				libApplied = true;
			}
			mainWritten = true;
			writeFileSync(mainPath, input.code);
			sourcesPrepared();
			compileStarted = performance.now();
			// The same deadline covers waiting for a permit, building, probing,
			// and running. No phase may start after cancellation or budget expiry.
			const admitted = timer.start("buildQueueMs");
			build = await withBuildPermit(() => {
				admitted();
				const command = cargoCommand(
					this.opts.cargoBin,
					["build", "--release", "--offline", "-p", "cell", "--message-format=json-diagnostic-rendered-ansi"],
					{ cwd: ws, cargoSandbox: this.opts.cargoSandbox, processLimits: this.opts.processLimits },
				);
				return timer.measure("cargoMs", () =>
					runProcess(command.bin, command.args, {
						cwd: ws,
						env: command.env,
						timeoutMs: remainingMs(),
						signal,
					}),
				);
			}, signal)
				.finally(admitted)
				.catch((error) => {
					if (signal.aborted) {
						return {
							exitCode: null,
							stdout: "",
							stderr: "",
							aborted: true,
							timedOut: false,
						} satisfies ProcOutcome;
					}
					throw error;
				});
			buildSucceeded = build.exitCode === 0 && !build.aborted && !build.timedOut;
		} finally {
			sourcesPrepared();
			if (!buildSucceeded) {
				const rolledBack = timer.start("rollbackMs");
				if (applied) revertLib(applied);
				if (mainWritten) {
					if (previousMain === null) rmSync(mainPath, { force: true });
					else writeFileSync(mainPath, previousMain);
				}
				rolledBack();
			}
		}
		const compileMs = performance.now() - compileStarted;

		if (build.aborted || build.timedOut) {
			return this.result(interruptedStatus(), {
				started,
				compileMs,
				runMs: 0,
				libApplied,
				libReverted: libApplied,
				stderr: "cell build was interrupted",
			});
		}

		if (build.exitCode !== 0) {
			return this.result("compile_error", {
				started,
				compileMs,
				runMs: 0,
				libApplied,
				libReverted: libApplied,
				compileDiagnostics: truncate(renderedDiagnostics(build.stdout, build.stderr)),
			});
		}

		// D14 rich output: synthesize a diff per applied lib file for the TUI.
		const diffs: CellResult["diffs"] =
			applied && input.lib
				? input.lib.map((file) => {
						const target = join(ws, "agent_lib", file.path);
						return {
							path: `agent_lib/${file.path}`,
							oldStr: applied.backups.get(target) ?? "",
							newStr: file.content,
						};
					})
				: [];
		const attachments: CellResult["attachments"] = [];
		const sentAgentMessages: CellResult["sentAgentMessages"] = [];
		try {
			await timer.measure("importPolicyMs", async () => {
				const wasm = await readFile(this.cellArtifact(), { signal });
				await validateWasiImports(wasm, "cell", signal);
			});
		} catch (error) {
			return this.result(signal.aborted ? interruptedStatus() : "error", {
				started,
				compileMs,
				runMs: 0,
				libApplied,
				libReverted: false,
				diffs,
				stderr: truncate(`cell did not run: ${error instanceof Error ? error.message : String(error)}`),
			});
		}
		const probe = this.probed
			? undefined
			: await timer.measure("probeMs", () => this.probeLibReadonly(remainingMs(), signal));
		if (probe && (probe.aborted || probe.timedOut || probe.exitCode !== 0)) {
			return this.result(probe.aborted || probe.timedOut ? interruptedStatus() : "error", {
				started,
				compileMs,
				runMs: 0,
				libApplied,
				libReverted: false,
				diffs,
				stderr: truncate(`readonly preopen probe failed; the cell did not run\n${probe.stderr}${probe.stdout}`),
			});
		}

		const bridge = this.opts.bridge;
		const cellEnv: Record<string, string> = { ...this.opts.cellEnv };
		if (bridge) {
			bridge.beginCell({
				cellId,
				code: input.code,
				signal,
				sinks: {
					onDiff: (diff) => diffs.push(diff),
					onAttachment: (attachment) => attachments.push(attachment),
					onSentAgentMessage: (message) => sentAgentMessages.push(message),
				},
			});
			cellEnv.RLM_BRIDGE_STDIO = "1";
			cellEnv.RLM_BRIDGE_TOKEN = bridge.token;
			cellEnv.RLM_CELL_ID = cellId;
			cellEnv.RLM_CELL_TIMEOUT_MS = String(this.opts.cellTimeoutMs);
		}

		const runStarted = performance.now();
		let exec: ProcOutcome;
		try {
			exec = await timer.measure("executionMs", () =>
				runProcess(this.opts.wasmedgeBin, this.wasmedgeArgs(cellEnv), {
					cwd: ws,
					timeoutMs: remainingMs(),
					signal,
					onChunk: per.onChunk,
					processLimits: this.opts.processLimits,
					bridge: bridge
						? { token: bridge.token, attach: (connection) => bridge.attachStdio(connection) }
						: undefined,
				}),
			);
		} finally {
			// Cancels cooperative handlers, waits briefly for pending receipts,
			// then drops the cell's connections.
			if (bridge) await timer.measure("bridgeCleanupMs", () => bridge.endCell());
		}
		const runMs = performance.now() - runStarted;

		const base = {
			started,
			compileMs,
			runMs,
			libApplied,
			libReverted: false,
			diffs,
			attachments,
			sentAgentMessages,
			stdout: truncate(exec.stdout),
			stderr: truncate(exec.stderr),
			exitCode: exec.exitCode ?? undefined,
		};
		if (exec.aborted || exec.timedOut) return this.result(interruptedStatus(), base);
		const result = this.result(exec.exitCode === 0 ? "ok" : "error", base);
		if (result.status === "ok" && this.opts.history) {
			const snapshotted = timer.start("snapshotMs");
			try {
				result.workspaceCommit = this.opts.history.snapshot(cellId);
			} catch (error) {
				result.workspaceCommitError = truncate(error instanceof Error ? error.message : String(error));
			}
			snapshotted();
		}
		return result;
	}

	private checkMounts(): void {
		const ws = this.opts.workspaceDir;
		const writableMounts = { "/agent/state": join(ws, "state"), "/scratch": join(ws, ".scratch") };
		assertHarnessMountsIsolated({ "/workspace": this.opts.cwd, ...writableMounts }, [
			this.opts.harnessDir,
			this.opts.globalHarnessDir,
		]);
		if (this.opts.workspaceWritePolicy === "ro") {
			assertReadonlyWorkspaceMounts(this.opts.cwd, writableMounts, { "/agent/lib": join(ws, "agent_lib") });
		}
	}

	private wasmedgeArgs(cellEnv: Record<string, string> = {}): string[] {
		const ws = this.opts.workspaceDir;
		this.checkMounts();
		const args: string[] = ["run", "--force-interpreter", ...this.resourceArgs];
		const projectAccess = this.opts.workspaceWritePolicy === "ro" ? ":readonly" : "";
		args.push("--dir", `/workspace:${realpathSync(this.opts.cwd)}${projectAccess}`);
		if (this.mountLibReadonly) {
			args.push("--dir", `/agent/lib:${join(ws, "agent_lib")}:readonly`);
		}
		args.push("--dir", `/agent/state:${join(ws, "state")}`);
		args.push("--dir", `/scratch:${createScratchDir(ws)}`);
		for (const [name, value] of Object.entries(cellEnv)) {
			args.push("--env", `${name}=${value}`);
		}
		args.push(this.cellArtifact());
		return args;
	}

	private cellArtifact(): string {
		return cargoArtifactPath(
			this.opts.workspaceDir,
			this.opts.cargoSandbox,
			join(cargoTargetDir(this.opts.workspaceDir, this.opts.cargoSandbox), "wasm32-wasip1", "release", "cell.wasm"),
		);
	}

	/** Defensive probe: if the readonly preopen ever fails to bind on this
	 * host (older wasmedge, exotic path), drop the lib mount entirely — never
	 * fall back to rw, which would let cells bypass the declarative lib flow
	 * (D14). Verified working normally on 0.17.1; see
	 * docs/wasmedge-readonly-preopen-investigation.md. */
	private async probeLibReadonly(timeoutMs: number, signal: AbortSignal): Promise<ProcOutcome | undefined> {
		if (this.probed) return;
		const ws = this.opts.workspaceDir;
		const dir = mkdtempSync(join(tmpdir(), "cell-preopen-probe-"));
		try {
			const wasm = join(dir, "probe.wasm");
			writeFileSync(wasm, PREOPEN_PROBE);
			const probe = await runProcess(
				this.opts.wasmedgeBin,
				["run", "--dir", `/agent/lib:${join(ws, "agent_lib")}:readonly`, wasm],
				{ cwd: ws, timeoutMs: Math.min(10_000, timeoutMs), signal, processLimits: this.opts.processLimits },
			);
			if (!probe.aborted && !probe.timedOut && probe.exitCode === 0) {
				this.probed = true;
				if (`${probe.stderr}${probe.stdout}`.includes("Bind guest directory failed")) {
					this.mountLibReadonly = false;
				}
			}
			return probe;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	private result(
		status: CellResult["status"],
		partial: {
			started: number;
			compileMs: number;
			runMs: number;
			libApplied: boolean;
			libReverted: boolean;
			diffs?: CellResult["diffs"];
			attachments?: CellResult["attachments"];
			sentAgentMessages?: CellResult["sentAgentMessages"];
			stdout?: string;
			stderr?: string;
			compileDiagnostics?: string;
			exitCode?: number;
		},
	): CellResult {
		return {
			status,
			stdout: partial.stdout ?? "",
			stderr: partial.stderr ?? "",
			compileDiagnostics: partial.compileDiagnostics,
			exitCode: partial.exitCode,
			durationMs: performance.now() - partial.started,
			compileMs: partial.compileMs,
			runMs: partial.runMs,
			libApplied: partial.libApplied,
			libReverted: partial.libReverted,
			libReadonlyFallback: !this.mountLibReadonly,
			diffs: partial.diffs ?? [],
			attachments: partial.attachments ?? [],
			sentAgentMessages: partial.sentAgentMessages ?? [],
		};
	}
}

/** Compose the model-visible tool text (DESIGN.md §2.5 assembly order). */
export function composeToolText(result: CellResult): string {
	const parts: string[] = [];
	if (result.status === "compile_error") {
		parts.push(result.compileDiagnostics ?? "compile failed");
		if (result.libReverted) {
			parts.push("[your lib files were reverted; the cell did not run]");
		}
	} else {
		if (result.stdout) parts.push(result.stdout);
		if (result.stderr) parts.push(result.stderr);
		if (result.status === "timeout") {
			parts.push(`[cell timed out after ${Math.round(result.durationMs)}ms and was killed]`);
		} else if (result.status === "aborted") {
			parts.push("[cell was aborted]");
		} else if (result.exitCode !== undefined && result.exitCode !== 0) {
			parts.push(`[cell exited with code ${result.exitCode}]`);
		}
	}
	if (result.workspaceCommitError) {
		parts.push(`[cell succeeded, but its workspace snapshot failed: ${result.workspaceCommitError}]`);
	}
	return parts.join("\n").trim();
}
