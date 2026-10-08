import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileAot, withoutCustomSections } from "../src/core/rust-cell/aot.js";
import { normalizeRustCellRuntimeMode } from "../src/core/rust-cell/runtime-mode.js";
import type { RunnerOptions } from "../src/core/rust-cell/types.js";

const fake = vi.hoisted(() => ({ calls: [] as { bin: string; args: string[]; env: NodeJS.ProcessEnv }[], mode: "ok" }));
vi.mock("../src/core/rust-cell/process.js", () => ({
	runProcess: async (bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
		fake.calls.push({ bin, args, env: opts.env });
		const input = readFileSync(args.at(-2)!);
		if (fake.mode !== "failure") {
			const native = Buffer.from([0, 10, 8, ...Buffer.from("wasmedge"), 1]);
			writeFileSync(args.at(-1)!, fake.mode === "missing-native" ? input : Buffer.concat([input, native]));
		}
		return {
			exitCode: fake.mode === "failure" ? 1 : 0,
			stdout: "",
			stderr: "compiler",
			aborted: false,
			timedOut: false,
		};
	},
}));
const empty = Buffer.from("0061736d01000000", "hex");
const submitted = Buffer.concat([empty, Buffer.from([0, 10, 8, ...Buffer.from("wasmedge"), 99])]);
const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	fake.calls.length = 0;
	fake.mode = "ok";
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): { directory: string; options: RunnerOptions } {
	const directory = mkdtempSync(join(tmpdir(), "cell-aot-"));
	roots.push(directory);
	return {
		directory,
		options: {
			cwd: directory,
			workspaceDir: directory,
			cargoBin: "cargo",
			wasmedgeBin: "wasmedge",
			cellTimeoutMs: 1000,
		},
	};
}
describe("host-generated AOT", () => {
	it("defaults to interpreter and rejects unknown modes", () => {
		expect(normalizeRustCellRuntimeMode(undefined)).toBe("interpreter");
		expect(normalizeRustCellRuntimeMode("aot")).toBe("aot");
		for (const value of [null, "jit", false])
			expect(() => normalizeRustCellRuntimeMode(value)).toThrow("runtimeMode");
	});
	it("removes guest native payloads and retains standard code sections", () => {
		const core = Buffer.from("0061736d0100000001040160000003020100070a01065f737461727400000a040102000b", "hex");
		expect(withoutCustomSections(Buffer.concat([core, submitted.subarray(8)]))).toEqual(core);
		for (const tail of [
			[0, 20],
			[0, 0x80],
			[0, 0xff, 0xff, 0xff, 0xff, 0x7f],
		])
			expect(() => withoutCustomSections(Buffer.concat([empty, Buffer.from(tail)]))).toThrow();
	});
	it("compiles stripped input, records provenance and instruments configured gas", async () => {
		const { directory, options } = fixture();
		vi.stubEnv("OPENAI_API_KEY", "must-not-reach-compiler");
		const result = await compileAot(
			{ ...options, cellGasLimit: 100 },
			directory,
			submitted,
			1000,
			new AbortController().signal,
		);
		expect(result.outcome.exitCode).toBe(0);
		expect(readFileSync(join(directory, "input.wasm"))).toEqual(empty);
		expect(fake.calls[0].args.slice(0, 3)).toEqual(["compile", "--interruptible", "--enable-gas-measuring"]);
		expect(fake.calls[0].env.OPENAI_API_KEY).toBeUndefined();
		expect(JSON.parse(readFileSync(join(directory, "provenance.json"), "utf8"))).toMatchObject({
			version: 1,
			artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});
	it("does not accept a compiler that silently returns an interpreter-only module", async () => {
		const { directory, options } = fixture();
		fake.mode = "missing-native";
		await expect(compileAot(options, directory, empty, 1000, new AbortController().signal)).rejects.toThrow(
			"no native",
		);
	});
	it("preserves compiler failures and stops before launch when already cancelled", async () => {
		const { directory, options } = fixture();
		fake.mode = "failure";
		expect((await compileAot(options, directory, empty, 1000, new AbortController().signal)).outcome.exitCode).toBe(
			1,
		);
		const controller = new AbortController();
		controller.abort();
		await expect(compileAot(options, directory, empty, 1000, controller.signal)).rejects.toThrow();
		expect(fake.calls).toHaveLength(1);
	});
});
