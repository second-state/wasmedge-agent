import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cargoEnvironment } from "./cargo-environment.js";
import { type ProcOutcome, runProcess } from "./process.js";
import type { RunnerOptions } from "./types.js";

const { WebAssembly } = globalThis as typeof globalThis & {
	WebAssembly: {
		Module: {
			new (bytes: Uint8Array<ArrayBuffer>): unknown;
			customSections(module: unknown, name: string): ArrayBuffer[];
		};
	};
};

/** Drop all guest custom sections, including any embedded native AOT payload.
 * The caller has already validated the complete module and its imports. */
export function withoutCustomSections(wasm: Uint8Array): Uint8Array {
	if (wasm.length < 8 || Buffer.from(wasm.subarray(0, 8)).toString("hex") !== "0061736d01000000")
		throw new Error("Invalid core Wasm header");
	const sections: Uint8Array[] = [wasm.subarray(0, 8)];
	let offset = 8;
	while (offset < wasm.length) {
		const start = offset;
		const id = wasm[offset++];
		let size = 0;
		let shift = 0;
		let byte: number;
		do {
			if (offset >= wasm.length || shift > 28) throw new Error("Invalid Wasm section length");
			byte = wasm[offset++];
			if (shift === 28 && byte & 0x70) throw new Error("Invalid Wasm section length");
			size += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		} while (byte & 0x80);
		if (size > wasm.length - offset) throw new Error("Truncated Wasm section");
		offset += size;
		if (id !== 0) sections.push(wasm.subarray(start, offset));
	}
	return Buffer.concat(sections);
}

export async function compileAot(
	options: RunnerOptions,
	directory: string,
	validatedWasm: Uint8Array,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<{ outcome: ProcOutcome; artifact: string }> {
	signal.throwIfAborted();
	const input = join(directory, "input.wasm");
	const artifact = join(directory, "cell.aot.wasm");
	const inspected = withoutCustomSections(validatedWasm);
	writeFileSync(input, inspected, { mode: 0o600 });
	const args = ["compile", "--interruptible"];
	if (options.cellGasLimit != null) args.push("--enable-gas-measuring");
	args.push(input, artifact);
	const outcome = await runProcess(process.env.WASMEDGE_AGENT_AOT_COMPILER ?? options.wasmedgeBin, args, {
		cwd: directory,
		env: cargoEnvironment(),
		timeoutMs,
		signal,
		processLimits: options.processLimits,
		processGroup: options.processGroup,
	});
	if (outcome.exitCode === 0 && !outcome.aborted && !outcome.timedOut) {
		const result = readFileSync(artifact);
		if (!Buffer.from(withoutCustomSections(result)).equals(Buffer.from(inspected)))
			throw new Error("AOT compiler changed the inspected Wasm code");
		if (!WebAssembly.Module.customSections(new WebAssembly.Module(result), "wasmedge").some((s) => s.byteLength))
			throw new Error("AOT compiler produced no native WasmEdge payload");
		const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
		writeFileSync(
			join(directory, "provenance.json"),
			JSON.stringify({
				version: 1,
				sourceSha256: digest(validatedWasm),
				inspectedSha256: digest(inspected),
				artifactSha256: digest(result),
				compiler: options.wasmedgeBin,
				args,
			}),
			{ mode: 0o600 },
		);
	}
	return { outcome, artifact };
}
