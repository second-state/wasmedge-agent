import { type ChildProcess, spawn } from "node:child_process";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ProcessResourceGroup } from "./process-group.js";
import { type ProcessLimits, resourceLimitedCommand } from "./process-limits.js";
import { StdioBridge } from "./stdio-bridge.js";
import { MAX_OUTPUT_CHARS } from "./types.js";

export interface ProcOutcome {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

export function runProcess(
	bin: string,
	args: string[],
	opts: {
		cwd: string;
		timeoutMs: number;
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		processLimits?: ProcessLimits | null;
		processGroup?: ProcessResourceGroup | null;
		bridge?: { token: string; attach: (connection: Duplex) => void };
		onChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
	},
): Promise<ProcOutcome> {
	if (opts.signal?.aborted || opts.timeoutMs <= 0) {
		return Promise.resolve({
			exitCode: null,
			stdout: "",
			stderr: "",
			timedOut: opts.timeoutMs <= 0,
			aborted: opts.signal?.aborted ?? false,
		});
	}
	return new Promise((resolvePromise, rejectPromise) => {
		let child: ChildProcess;
		try {
			const command = resourceLimitedCommand(
				{ bin, args, env: opts.env ?? process.env },
				opts.processLimits,
				opts.processGroup,
			);
			child = spawn(command.bin, command.args, {
				cwd: opts.cwd,
				detached: true,
				stdio: [opts.bridge ? "pipe" : "ignore", "pipe", "pipe"],
				env: command.env,
			});
		} catch (err) {
			rejectPromise(err);
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let failure: { error: unknown } | undefined;
		let closed = false;
		let bridgeError: Error | undefined;
		let bridge: StdioBridge | undefined;
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");

		const killGroup = () => {
			if (closed) return;
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		};
		const fail = (error: unknown) => {
			if (failure) return;
			failure = { error };
			killGroup();
			bridge?.finish();
		};
		child.on("error", fail);

		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, opts.timeoutMs);

		const onAbort = () => killGroup();
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		const output = (text: string, stream: "stdout" | "stderr") => {
			if (!text) return;
			if (stream === "stdout") {
				if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += text;
			} else if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += text;
			opts.onChunk?.(text, stream);
		};
		if (opts.bridge && child.stdin) {
			bridge = new StdioBridge(
				child.stdin,
				opts.bridge.token,
				(data) => output(stdoutDecoder.write(data), "stdout"),
				(error) => {
					bridgeError ??= error;
					killGroup();
				},
			);
			try {
				opts.bridge.attach(bridge.connection);
			} catch (error) {
				fail(error);
			}
		}
		child.stdout?.on("data", (data: Buffer) => {
			if (bridge) bridge.write(data);
			else output(stdoutDecoder.write(data), "stdout");
		});
		child.stderr?.on("data", (data: Buffer) => {
			output(stderrDecoder.write(data), "stderr");
		});

		child.on("close", (code) => {
			closed = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			bridge?.finish();
			// Callers may roll back sources or start another cell after rejection.
			// A failed attachment/spawn must release its process and pipes first.
			if (failure) {
				rejectPromise(failure.error);
				return;
			}
			output(stdoutDecoder.end(), "stdout");
			output(stderrDecoder.end(), "stderr");
			if (bridgeError) output(`\n${bridgeError.message}\n`, "stderr");
			resolvePromise({
				exitCode: bridgeError && code === 0 ? 1 : code,
				stdout,
				stderr,
				timedOut,
				aborted: opts.signal?.aborted ?? false,
			});
		});
	});
}
