import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import * as skillTests from "../src/core/rust-cell/skill-tests.js";
import { SkillValidation } from "../src/core/rust-cell/skill-validation.js";
import { syncRustSkills } from "../src/core/rust-cell/workspace.js";

const reference = { type: "rust", use: "agent_lib::skills::example" };
const tempDirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const workspaceDir = mkdtempSync(join(tmpdir(), "skill-validation-"));
	tempDirs.push(workspaceDir);
	const crate = join(workspaceDir, "skills/example");
	mkdirSync(join(crate, "src"), { recursive: true });
	writeFileSync(join(crate, "Cargo.toml"), "[package]\nname = 'example'\n");
	const source = join(crate, "src/lib.rs");
	writeFileSync(source, "pub fn value() -> u32 { 42 }");
	mkdirSync(join(workspaceDir, "agent_lib"));
	writeFileSync(join(workspaceDir, "Cargo.toml"), '[workspace]\nmembers = ["agent_lib", "cell", "rlm"]\n');
	writeFileSync(join(workspaceDir, "agent_lib/Cargo.toml"), '[package]\nname = "agent_lib"\n[dependencies]\n');
	const skill = { name: "example", crateName: "example", cratePath: crate, cargoTomlPath: join(crate, "Cargo.toml") };
	syncRustSkills(workspaceDir, [skill]);
	const options = { workspaceDir, cargoBin: "cargo", wasmedgeBin: "wasmedge", timeoutMs: 30_000 };
	return { source, skill, options, gate: new SkillValidation(options) };
}

describe("skill source revalidation", () => {
	it.each(["dangling", "cycle"])("ignores %s links only in unmounted sources", async (kind) => {
		const f = fixture();
		const tests = vi.spyOn(skillTests, "testRustSkill").mockResolvedValue();
		const signal = new AbortController().signal;
		await f.gate.test(reference);
		const unmounted = join(f.options.workspaceDir, "skills/unmounted");
		mkdirSync(unmounted);
		const link = join(unmounted, "fixture");
		symlinkSync(kind === "cycle" ? unmounted : join(unmounted, "missing"), link);
		await f.gate.revalidate([reference], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(1);
		writeFileSync(join(unmounted, "notes"), "work in progress");
		await f.gate.revalidate([reference], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(1);
		const mountedLink = join(f.skill.cratePath, "fixture");
		symlinkSync(kind === "cycle" ? f.skill.cratePath : join(f.skill.cratePath, "missing"), mountedLink);
		await expect(f.gate.revalidate([reference], signal, 30_000)).rejects.toThrow(
			kind === "cycle" ? /symlink cycle/ : /ENOENT/,
		);
		expect(tests).toHaveBeenCalledTimes(1);
	});

	it("skips unmounted source copies and resumes validation after remounting", async () => {
		const f = fixture();
		const tests = vi.spyOn(skillTests, "testRustSkill").mockResolvedValue();
		const signal = new AbortController().signal;
		await f.gate.test(reference);
		writeFileSync(f.source, "not Rust");
		syncRustSkills(f.options.workspaceDir, []);
		await f.gate.revalidate([reference], signal, 30_000);
		await new SkillValidation(f.options).revalidate([reference], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(1);
		expect(readFileSync(f.source, "utf8")).toBe("not Rust");
		writeFileSync(f.source, "pub fn value() -> u32 { 43 }");
		syncRustSkills(f.options.workspaceDir, [f.skill]);
		await f.gate.revalidate([reference], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(2);
	});

	it("caches successful tests but retests changed sources and dependency context", async () => {
		const f = fixture();
		const tests = vi.spyOn(skillTests, "testRustSkill").mockResolvedValue();
		const signal = new AbortController().signal;
		await f.gate.revalidate([], signal, 30_000);
		expect(tests).not.toHaveBeenCalled();
		await f.gate.test(reference);
		await f.gate.revalidate([reference, reference], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(1);
		writeFileSync(f.source, "pub fn value() -> u32 { 43 }");
		await f.gate.revalidate([], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(2);
		writeFileSync(join(f.options.workspaceDir, "Cargo.lock"), "new dependency revision");
		await f.gate.revalidate([], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(3);
		const resumed = new SkillValidation(f.options);
		await resumed.revalidate([reference], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(4);
	});

	it("retests library source and fixtures without tracking its build output", async () => {
		const f = fixture();
		const tests = vi.spyOn(skillTests, "testRustSkill").mockResolvedValue();
		const signal = new AbortController().signal;
		await f.gate.test(reference);
		for (const path of ["src/helper.rs", "fixtures/expected.txt", "build.rs"]) {
			const file = join(f.options.workspaceDir, "agent_lib", path);
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, "changed");
			await f.gate.revalidate([], signal, 30_000);
		}
		expect(tests).toHaveBeenCalledTimes(4);
		for (const ignored of ["target", ".git"]) {
			const path = join(f.options.workspaceDir, "agent_lib", ignored);
			mkdirSync(path);
			writeFileSync(join(path, "output"), "ignored");
		}
		await f.gate.revalidate([], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(4);
	});

	it("does not cache failures, cancellation, or edits made during testing", async () => {
		const f = fixture();
		const tests = vi.spyOn(skillTests, "testRustSkill").mockResolvedValue();
		const signal = new AbortController().signal;
		await f.gate.test(reference);
		writeFileSync(f.source, "changed");
		tests.mockRejectedValueOnce(new Error("assertion failed"));
		await expect(f.gate.revalidate([], signal, 30_000)).rejects.toThrow("assertion failed");
		tests.mockImplementationOnce(async () => {
			writeFileSync(f.source, "changed during test");
		});
		await expect(f.gate.revalidate([], signal, 30_000)).rejects.toThrow("changed during testing");
		const abort = new AbortController();
		tests.mockImplementationOnce(async () => {
			abort.abort(new Error("cancelled"));
		});
		await expect(f.gate.revalidate([], abort.signal, 30_000)).rejects.toThrow("cancelled");
		await f.gate.revalidate([], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(5);
		await f.gate.revalidate([], signal, 30_000);
		expect(tests).toHaveBeenCalledTimes(5);
	});

	it("blocks cells before source edits and reports cancellation within the cell budget", async () => {
		const f = fixture();
		mkdirSync(join(f.options.workspaceDir, "cell/src"), { recursive: true });
		const main = join(f.options.workspaceDir, "cell/src/main.rs");
		writeFileSync(main, "previous cell");
		const validateSkills = vi.fn().mockRejectedValue(new Error("skill tests failed"));
		const runner = new CellRunner({
			...f.options,
			cwd: f.options.workspaceDir,
			cellTimeoutMs: 30_000,
			validateSkills,
		});
		const input = { code: "replacement", lib: [{ path: "src/lib.rs", content: "replacement" }] };
		const result = await runner.execute(input);
		expect(result).toMatchObject({ status: "error", compileMs: 0, runMs: 0, libApplied: false });
		expect(result.stderr).toContain("skill tests failed");
		expect(readFileSync(main, "utf8")).toBe("previous cell");
		expect(validateSkills.mock.calls[0][1]).toBeLessThanOrEqual(30_000);
		const abort = new AbortController();
		abort.abort();
		expect(await runner.execute(input, { signal: abort.signal })).toMatchObject({ status: "aborted", runMs: 0 });
		const timed = new CellRunner({
			...f.options,
			cwd: f.options.workspaceDir,
			cellTimeoutMs: 10,
			validateSkills: (signal) =>
				new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
		});
		expect(await timed.execute(input)).toMatchObject({ status: "timeout", runMs: 0, libApplied: false });
	});
});
