import { type ChildProcess, spawn } from "node:child_process";
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
			child = spawn(bin, args, {
				cwd: opts.cwd,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: opts.env ?? process.env,
			});
		} catch (err) {
			rejectPromise(err);
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settledEarly = false;

		const killGroup = () => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, opts.timeoutMs);

		const onAbort = () => killGroup();
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += text;
			opts.onChunk?.(text, "stdout");
		});
		child.stderr?.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += text;
			opts.onChunk?.(text, "stderr");
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			settledEarly = true;
			rejectPromise(err);
		});

		child.on("close", (code) => {
			if (settledEarly) return;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				exitCode: code,
				stdout,
				stderr,
				timedOut,
				aborted: opts.signal?.aborted ?? false,
			});
		});
	});
}
