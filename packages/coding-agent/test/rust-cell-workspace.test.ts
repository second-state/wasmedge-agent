import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { applyLib, revertLib } from "../src/core/rust-cell/workspace.js";

describe("cell source rollback", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function workspace(): string {
		const dir = mkdtempSync(join(tmpdir(), "cell-rollback-"));
		dirs.push(dir);
		mkdirSync(join(dir, "agent_lib", "src", "helpers"), { recursive: true });
		mkdirSync(join(dir, "cell", "src"), { recursive: true });
		writeFileSync(join(dir, "cell", "src", "main.rs"), "fn main() {}\n");
		writeFileSync(join(dir, "agent_lib", "src", "lib.rs"), "pub mod helpers;\n");
		writeFileSync(join(dir, "agent_lib", "src", "helpers", "mod.rs"), "pub fn existing() {}\n");
		return dir;
	}

	it("validates all paths before writing any file", () => {
		const ws = workspace();
		expect(() =>
			applyLib(ws, [
				{ path: "src/lib.rs", content: "broken" },
				{ path: "../escape.rs", content: "" },
			]),
		).toThrow(/escapes/);
		expect(readFileSync(join(ws, "agent_lib", "src", "lib.rs"), "utf-8")).toBe("pub mod helpers;\n");
	});

	it("restores the original contents when normalized paths repeat", () => {
		const ws = workspace();
		const applied = applyLib(ws, [
			{ path: "src/lib.rs", content: "first" },
			{ path: "src/./lib.rs", content: "second" },
		]);
		expect(readFileSync(join(ws, "agent_lib", "src", "lib.rs"), "utf-8")).toBe("second");
		revertLib(applied);
		expect(readFileSync(join(ws, "agent_lib", "src", "lib.rs"), "utf-8")).toBe("pub mod helpers;\n");
	});

	it.each([true, false])("restores the generated module index (previously present: %s)", (present) => {
		const ws = workspace();
		const mod = join(ws, "agent_lib", "src", "helpers", "mod.rs");
		if (!present) rmSync(mod);
		const applied = applyLib(ws, [{ path: "src/helpers/new.rs", content: "pub fn added() {}" }]);
		expect(readFileSync(mod, "utf-8")).toContain("pub mod new;");
		revertLib(applied);
		expect(existsSync(join(ws, "agent_lib", "src", "helpers", "new.rs"))).toBe(false);
		expect(existsSync(mod)).toBe(present);
		if (present) expect(readFileSync(mod, "utf-8")).toBe("pub fn existing() {}\n");
	});

	it("restores earlier writes when creating a later parent directory fails", () => {
		const ws = workspace();
		writeFileSync(join(ws, "agent_lib", "src", "blocked"), "a file, not a directory");
		expect(() =>
			applyLib(ws, [
				{ path: "src/lib.rs", content: "broken" },
				{ path: "src/blocked/new.rs", content: "" },
			]),
		).toThrow();
		expect(readFileSync(join(ws, "agent_lib", "src", "lib.rs"), "utf-8")).toBe("pub mod helpers;\n");
		expect(readFileSync(join(ws, "agent_lib", "src", "helpers", "mod.rs"), "utf-8")).toBe("pub fn existing() {}\n");
	});

	it.each(["missing compiler", "pre-aborted"])("preserves previous cell and lib after %s", async (failure) => {
		const ws = workspace();
		const runner = new CellRunner({
			workspaceDir: ws,
			cwd: ws,
			cargoBin: join(ws, "missing-cargo"),
			wasmedgeBin: join(ws, "missing-wasmedge"),
			cellTimeoutMs: 5_000,
		});
		const result = runner.execute(
			{ code: "broken main", lib: [{ path: "src/helpers/new.rs", content: "broken helper" }] },
			failure === "pre-aborted" ? { signal: AbortSignal.abort() } : {},
		);
		if (failure === "pre-aborted") {
			expect(await result).toMatchObject({
				status: "aborted",
				compileMs: 0,
				runMs: 0,
				libApplied: false,
				libReverted: false,
			});
			expect(existsSync(join(ws, "state"))).toBe(false);
		} else {
			await expect(result).rejects.toThrow(/ENOENT/);
		}
		expect(readFileSync(join(ws, "cell", "src", "main.rs"), "utf-8")).toBe("fn main() {}\n");
		expect(readFileSync(join(ws, "agent_lib", "src", "helpers", "mod.rs"), "utf-8")).toBe("pub fn existing() {}\n");
		expect(existsSync(join(ws, "agent_lib", "src", "helpers", "new.rs"))).toBe(false);
	});
});
