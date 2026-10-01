import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { assertHarnessMountsIsolated } from "../src/core/rust-cell/harness-mounts.js";

describe("harness mount isolation", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	function setup() {
		const root = mkdtempSync(join(tmpdir(), "harness-mount-"));
		roots.push(root);
		return root;
	}

	it("rejects parent, exact, and nested writable mounts for either store, including stores not yet created", () => {
		const root = setup();
		const store = join(root, "harness");
		for (const mounted of [root, store, join(store, "nested")]) {
			for (const stores of [
				[store, undefined],
				[undefined, store],
			]) {
				expect(() => assertHarnessMountsIsolated({ "/workspace": mounted }, stores)).toThrow("overlaps");
			}
		}
		expect(() => assertHarnessMountsIsolated({ "/workspace": join(root, "harness-project") }, [store])).not.toThrow();
	});

	it("resolves symlinked mounts, store parents, and existing state-file targets", () => {
		const root = setup();
		const physical = join(root, "physical");
		mkdirSync(physical);
		const alias = join(root, "alias");
		symlinkSync(physical, alias, "dir");
		expect(() => assertHarnessMountsIsolated({ "/workspace": alias }, [join(physical, "harness")])).toThrow(
			"overlaps",
		);
		expect(() => assertHarnessMountsIsolated({ "/workspace": physical }, [join(alias, "harness")])).toThrow(
			"overlaps",
		);
		const store = join(root, "store");
		mkdirSync(store);
		writeFileSync(join(physical, "state.json"), "{}");
		symlinkSync(join(physical, "state.json"), join(store, "harness_state.json"));
		expect(() => assertHarnessMountsIsolated({ "/workspace": physical }, [store])).toThrow("overlaps");
	});

	it.each(["state", ".scratch"])("rejects %s overlap before writing or compiling a cell", async (mount) => {
		const root = setup();
		const runner = new CellRunner({
			cwd: join(root, "project"),
			workspaceDir: join(root, "workspace"),
			harnessDir: join(root, "workspace", mount, "harness"),
			cargoBin: "must-not-run",
			wasmedgeBin: "must-not-run",
			cellTimeoutMs: 1000,
		});
		await expect(runner.execute({ code: "fn main() {}" })).rejects.toThrow(
			mount === "state" ? "/agent/state" : "/scratch",
		);
	});
});
