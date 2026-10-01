/** The cell execution pipeline: apply lib files -> cargo build -> wasmedge run
 * -> structured result. DESIGN.md §2.3–§2.5. */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBuildPermit } from "./build-gate.js";
import { type ProcOutcome, runProcess } from "./process.js";
import { wasmedgeResourceArgs } from "./resource-limits.js";
import { type CellInput, type CellResult, type PerCallOptions, type RunnerOptions, truncate } from "./types.js";
import { type AppliedLib, applyLib, createScratchDir, ensureStateDir, revertLib } from "./workspace.js";

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
	private mountLibReadonly = true;
	private probed = false;
	private readonly opts: RunnerOptions;
	private readonly resourceArgs: string[];

	constructor(opts: RunnerOptions) {
		this.resourceArgs = wasmedgeResourceArgs(opts);
		this.opts = opts;
	}

	/** Serialize cells (executionMode "sequential" is also enforced host-side). */
	execute(input: CellInput, per: PerCallOptions = {}): Promise<CellResult> {
		const run = this.queue.then(() => this.executeInner(input, per));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async executeInner(input: CellInput, per: PerCallOptions): Promise<CellResult> {
		const started = Date.now();
		const cellId = per.cellId ?? `cell-${randomBytes(6).toString("hex")}`;
		const deadline = AbortSignal.timeout(this.opts.cellTimeoutMs);
		const signal = per.signal ? AbortSignal.any([per.signal, deadline]) : deadline;
		const remainingMs = () => this.opts.cellTimeoutMs - (Date.now() - started);
		const interruptedStatus = () => (per.signal?.aborted ? "aborted" : "timeout");
		const ws = this.opts.workspaceDir;
		ensureStateDir(ws);

		let applied: AppliedLib | undefined;
		let libApplied = false;
		const mainPath = join(ws, "cell", "src", "main.rs");
		const previousMain = existsSync(mainPath) ? readFileSync(mainPath, "utf-8") : null;
		let mainWritten = false;
		let buildSucceeded = false;
		let compileStarted = Date.now();
		let build: ProcOutcome;
		try {
			if (input.lib && input.lib.length > 0) {
				applied = applyLib(ws, input.lib);
				libApplied = true;
			}
			mainWritten = true;
			writeFileSync(mainPath, input.code);
			compileStarted = Date.now();
			// The same deadline covers waiting for a permit, building, probing,
			// and running. No phase may start after cancellation or budget expiry.
			build = await withBuildPermit(
				() =>
					runProcess(
						this.opts.cargoBin,
						["build", "--release", "--offline", "-p", "cell", "--message-format=json-diagnostic-rendered-ansi"],
						{
							cwd: ws,
							timeoutMs: remainingMs(),
							signal,
						},
					),
				signal,
			).catch((error) => {
				if (signal.aborted) {
					return { exitCode: null, stdout: "", stderr: "", aborted: true, timedOut: false } satisfies ProcOutcome;
				}
				throw error;
			});
			buildSucceeded = build.exitCode === 0 && !build.aborted && !build.timedOut;
		} finally {
			if (!buildSucceeded) {
				if (applied) revertLib(applied);
				if (mainWritten) {
					if (previousMain === null) rmSync(mainPath, { force: true });
					else writeFileSync(mainPath, previousMain);
				}
			}
		}
		const compileMs = Date.now() - compileStarted;

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
		const probe = await this.probeLibReadonly(remainingMs(), signal);
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
			await bridge.start();
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
			cellEnv.RLM_BRIDGE_ADDR = bridge.address;
			cellEnv.RLM_BRIDGE_TOKEN = bridge.token;
			cellEnv.RLM_CELL_ID = cellId;
			cellEnv.RLM_CELL_TIMEOUT_MS = String(this.opts.cellTimeoutMs);
		}

		const runStarted = Date.now();
		let exec: ProcOutcome;
		try {
			exec = await runProcess(this.opts.wasmedgeBin, this.wasmedgeArgs(cellEnv), {
				cwd: ws,
				timeoutMs: remainingMs(),
				signal,
				onChunk: per.onChunk,
			});
		} finally {
			// Cancels cooperative handlers, waits briefly for pending receipts,
			// then drops the cell's connections.
			if (bridge) await bridge.endCell();
		}
		const runMs = Date.now() - runStarted;

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
			try {
				result.workspaceCommit = this.opts.history.snapshot(cellId);
			} catch (error) {
				result.workspaceCommitError = truncate(error instanceof Error ? error.message : String(error));
			}
			result.durationMs = Date.now() - started;
		}
		return result;
	}

	private wasmedgeArgs(cellEnv: Record<string, string> = {}): string[] {
		const ws = this.opts.workspaceDir;
		const args: string[] = ["run", ...this.resourceArgs];
		args.push("--dir", `/workspace:${realpathSync(this.opts.cwd)}`);
		if (this.mountLibReadonly) {
			args.push("--dir", `/agent/lib:${join(ws, "agent_lib")}:readonly`);
		}
		args.push("--dir", `/agent/state:${join(ws, "state")}`);
		// Harness stores are shared with the host /refine flow; rlm::harness
		// handles concurrent writers via its mtime re-sync (DESIGN §4.3).
		if (this.opts.harnessDir) {
			mkdirSync(this.opts.harnessDir, { recursive: true });
			args.push("--dir", `/agent/harness:${this.opts.harnessDir}`);
		}
		if (this.opts.globalHarnessDir) {
			mkdirSync(this.opts.globalHarnessDir, { recursive: true });
			args.push("--dir", `/agent/harness-global:${this.opts.globalHarnessDir}`);
		}
		args.push("--dir", `/scratch:${createScratchDir(ws)}`);
		for (const [name, value] of Object.entries(cellEnv)) {
			args.push("--env", `${name}=${value}`);
		}
		args.push(join(ws, "target", "wasm32-wasip1", "release", "cell.wasm"));
		return args;
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
				{ cwd: ws, timeoutMs: Math.min(10_000, timeoutMs), signal },
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
			durationMs: Date.now() - partial.started,
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
			parts.push(`[cell timed out after ${result.durationMs}ms and was killed]`);
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
