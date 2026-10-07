import { type ProcOutcome, runProcess } from "./process.js";

/** One deadline for toolchain probes, template preparation and scaffold builds. */
export class ProvisioningContext {
	private readonly controller = new AbortController();
	private readonly deadline: number;
	private readonly timer: ReturnType<typeof setTimeout>;
	readonly signal: AbortSignal;

	constructor(
		lifetime: AbortSignal,
		private readonly timeoutMs: number,
		private readonly operation = "Rust cell provisioning",
	) {
		this.signal = AbortSignal.any([lifetime, this.controller.signal]);
		this.deadline = performance.now() + timeoutMs;
		this.timer = setTimeout(() => this.abort(this.timeoutError()), timeoutMs);
	}

	private timeoutError(): Error {
		return new Error(`${this.operation} timed out after ${this.timeoutMs} ms`);
	}

	check(): void {
		if (performance.now() >= this.deadline) this.abort(this.timeoutError());
		this.signal.throwIfAborted();
	}

	abort(reason: unknown): void {
		this.controller.abort(reason);
	}

	dispose(): void {
		clearTimeout(this.timer);
	}

	/** Only for barriers we do not own; subprocesses must drain before returning. */
	async wait<T>(promise: Promise<T>): Promise<T> {
		this.check();
		let onAbort!: () => void;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(this.signal.reason);
					this.signal.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		} finally {
			this.signal.removeEventListener("abort", onAbort);
		}
	}

	async run(command: { bin: string; args: string[]; env?: NodeJS.ProcessEnv }, cwd: string): Promise<ProcOutcome> {
		this.check();
		const result = await runProcess(command.bin, command.args, {
			cwd,
			env: command.env,
			signal: this.signal,
			timeoutMs: Math.max(0, this.deadline - performance.now()),
		});
		if (result.timedOut) this.abort(this.timeoutError());
		this.check();
		return result;
	}

	async exec(command: { bin: string; args: string[]; env?: NodeJS.ProcessEnv }, cwd: string): Promise<string> {
		const result = await this.run(command, cwd);
		if (result.exitCode !== 0) {
			throw new Error(`${command.bin} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		return result.stdout.trim();
	}
}
