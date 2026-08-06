/** rlm::harness over the /agent/harness preopens (DESIGN.md §4.3): a wasm
 * cell writes entries the host reads back through loadHarnessState, and a
 * host-written store survives concurrent cell mutations (mtime re-sync).
 * Skipped without the Rust/WasmEdge toolchain + warm template. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadHarnessState } from "../src/core/refinement/refinement.js";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo } from "../src/core/rust-cell/toolchain.js";
import { ensureWorkspaceAt } from "../src/core/rust-cell/workspace.js";

let toolchain: ToolchainInfo | undefined;
try {
	toolchain = resolveToolchain();
} catch {
	toolchain = undefined;
}
const available = toolchain !== undefined && isTemplateWarm();

const CELL_CODE = `use agent_lib::prelude::*;

fn main() -> Result<()> {
    let mut harness = rlm::harness::local()?;
    harness.create_memory("Build Uses Ninja", "ninja -C out")?;
    harness.create_skill(
        "Log Parser",
        "Parse CI logs",
        serde_json::json!({
            "type": "rust",
            "use": "agent_lib::skills::log_parser",
            "call_pattern": "agent_lib::skills::log_parser::run(path)?"
        }),
        serde_json::json!({"path": "required"}),
    )?;
    println!("overview:\\n{}", harness.overview()?);
    match rlm::harness::global() {
        Ok(_) => println!("global=ok"),
        Err(e) => println!("global-err={e:#}"),
    }
    Ok(())
}
`;

describe.skipIf(!available)("rust cell <-> harness store integration", () => {
	const tempDirs: string[] = [];
	afterAll(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	});

	it("cells write entries the host reads, without clobbering host state", { timeout: 300_000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "harness-int-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const workspace = ensureWorkspaceAt(join(root, "workspace"));
		const harnessDir = join(root, "harness");
		const globalHarnessDir = join(root, "harness-global");

		// Pre-seed the local store as the host /refine flow would.
		mkdirSync(harnessDir, { recursive: true });
		writeFileSync(
			join(harnessDir, "harness_state.json"),
			JSON.stringify(
				{
					schema: 1,
					entries: {
						prompt: {},
						memory: {
							host_seeded: {
								id: "host_seeded",
								kind: "memory",
								title: "Host Seeded",
								content: "written by the host",
								path: "general",
								scope: "local",
								reference: {},
								arguments: {},
								metadata: {},
								source: "refine",
								created_at: "2026-01-01T00:00:00Z",
								updated_at: "2026-01-01T00:00:00Z",
								version: 1,
							},
						},
						skill: {},
						subagent: {},
					},
					refinements: [],
				},
				null,
				2,
			),
		);

		const runner = new CellRunner({
			cwd,
			workspaceDir: workspace,
			wasmedgeBin: toolchain?.wasmedgeBin as string,
			cargoBin: toolchain?.cargoBin as string,
			cellTimeoutMs: 240_000,
			harnessDir,
			globalHarnessDir,
		});
		const result = await runner.execute({ code: CELL_CODE });
		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("global=ok");
		expect(result.stdout).toContain("[local:build_uses_ninja]");

		const state = loadHarnessState(harnessDir, "local");
		expect(Object.keys(state.entries.memory).sort()).toEqual(["build_uses_ninja", "host_seeded"]);
		expect(state.entries.memory.host_seeded?.content).toBe("written by the host");
		const skill = state.entries.skill.log_parser;
		expect(skill?.reference).toMatchObject({ type: "rust", use: "agent_lib::skills::log_parser" });
	});
});
