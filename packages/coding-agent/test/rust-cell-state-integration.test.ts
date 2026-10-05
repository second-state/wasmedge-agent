import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo } from "../src/core/rust-cell/toolchain.js";
import { ensureWorkspaceAt, listPersistentState } from "../src/core/rust-cell/workspace.js";

let toolchain: ToolchainInfo | undefined;
try {
	toolchain = resolveToolchain();
} catch {
	toolchain = undefined;
}
const available = toolchain !== undefined && isTemplateWarm();

describe.skipIf(!available)("persistent state writes in WasmEdge", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("preserves sibling files and failed-write destinations across cells", { timeout: 180_000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "cell-state-write-"));
		dirs.push(root);
		const cwd = join(root, "project");
		mkdirSync(cwd);
		const workspace = ensureWorkspaceAt(join(root, "workspace"));
		const state = join(workspace, "state");
		const blobs = join(state, "blobs");
		mkdirSync(join(blobs, "blocked.bin"), { recursive: true });
		writeFileSync(join(blobs, "blocked.bin", "keep"), "keep");
		writeFileSync(join(blobs, "blocked.tmp"), "saved blocked blob");
		writeFileSync(join(blobs, "data.tmp"), "saved data blob");
		writeFileSync(join(state, "state.tmp"), "saved state file");
		mkdirSync(join(blobs, ".rlm-write-0.tmp"));
		writeFileSync(join(blobs, ".rlm-write-0.tmp", "value"), "interrupted write");
		const runner = new CellRunner({
			cwd,
			workspaceDir: workspace,
			cargoBin: toolchain!.cargoBin,
			wasmedgeBin: toolchain!.wasmedgeBin,
			cellTimeoutMs: 180_000,
		});

		for (const count of [1, 2]) {
			const result = await runner.execute({
				code: `use agent_lib::prelude::*;
fn main() -> Result<()> {
    assert_eq!(rlm::state::get::<u64>("count")?.unwrap_or(0), ${count - 1});
    rlm::state::set("count", &${count}u64)?;
    rlm::state::put_blob("data.bin", b"value ${count}")?;
    rlm::state::put_blob("created.tmp", b"saved by guest")?;
    assert_eq!(rlm::state::get_blob("data.tmp")?.unwrap(), b"saved data blob");
    assert!(rlm::state::put_blob("blocked.bin", b"replacement").is_err());
    assert_eq!(rlm::state::get_blob("blocked.tmp")?.unwrap(), b"saved blocked blob");
    assert_eq!(rlm::state::list_blobs()?, vec!["blocked.tmp", "created.tmp", "data.bin", "data.tmp"]);
    assert_eq!(std::fs::read("/agent/state/state.tmp")?, b"saved state file");
    Ok(())
}`,
			});
			expect(result.status, result.stderr).toBe("ok");
			expect(JSON.parse(readFileSync(join(state, "state.json"), "utf-8"))).toEqual({ count });
			expect(readFileSync(join(blobs, "data.bin"), "utf-8")).toBe(`value ${count}`);
			expect(readFileSync(join(blobs, "blocked.bin", "keep"), "utf-8")).toBe("keep");
			expect(readFileSync(join(blobs, ".rlm-write-0.tmp", "value"), "utf-8")).toBe("interrupted write");
			expect(readdirSync(blobs).sort()).toEqual([
				".rlm-write-0.tmp",
				"blocked.bin",
				"blocked.tmp",
				"created.tmp",
				"data.bin",
				"data.tmp",
			]);
			expect(readdirSync(state).sort()).toEqual(["blobs", "state.json", "state.tmp"]);
			expect(listPersistentState(workspace)).toMatchObject({
				stateKeys: ["count"],
				blobNames: ["blocked.tmp", "created.tmp", "data.bin", "data.tmp"],
			});
		}
	});
});
