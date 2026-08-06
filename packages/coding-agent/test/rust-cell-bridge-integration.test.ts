/** Real-toolchain bridge round-trip: compile a cell with cargo, run it in
 * wasmedge with RLM_BRIDGE_* env, and drive rlm::{host_request, spawn, msg,
 * display} against fake host handlers. Skipped when the Rust/WasmEdge
 * toolchain or the warm template is unavailable (DESIGN.md §9: these run in a
 * dedicated toolchain CI job, not the default shards). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BridgeServer } from "../src/core/rust-cell/bridge-server.js";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo } from "../src/core/rust-cell/toolchain.js";
import type { CellResult } from "../src/core/rust-cell/types.js";
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
    let reply = rlm::host_request("test.echo", serde_json::json!({"n": 41}))?;
    println!("echo={}", reply["n"]);
    let handle = rlm::spawn_named("review the API", "worker")?;
    println!("spawned={}", handle.rlm_child_id);
    rlm::display::diff("demo.txt", "old", "new")?;
    let receipt = rlm::msg::send_to_parent("hello from the sandbox")?;
    println!("delivery={}", receipt["deliveryStatus"].as_str().unwrap_or("?"));
    match rlm::host_request("missing.type", serde_json::json!({})) {
        Err(e) => println!("missing-err={:#}", e),
        Ok(_) => println!("missing-err=NONE"),
    }
    Ok(())
}
`;

describe.skipIf(!available)("rust cell <-> bridge integration", () => {
	const tempDirs: string[] = [];
	const servers: BridgeServer[] = [];

	afterAll(async () => {
		for (const server of servers) await server.dispose();
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	});

	it("drives host_request, spawn, emit, and agent messages from a wasm cell", { timeout: 180_000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "bridge-int-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		const workspace = join(root, "workspace");
		ensureWorkspaceAt(workspace);

		const seenTypes: string[] = [];
		let echoCellSource = "";
		const bridge = new BridgeServer({
			handlers: {
				"test.echo": async (payload) => {
					seenTypes.push("test.echo");
					echoCellSource = String(payload.cellSourceCode ?? "");
					return { n: (payload.n as number) + 1 };
				},
				"rlm.run": async (payload) => {
					seenTypes.push("rlm.run");
					expect(payload.prompt).toBe("review the API");
					expect((payload.kwargs as Record<string, unknown>).name).toBe("worker");
					return {
						rlm_child_id: "child-7",
						name: "worker",
						session_dir: "/tmp/child-7",
						model: "prov/model-1",
					};
				},
				"agent_message.send": async (payload) => {
					seenTypes.push("agent_message.send");
					expect(payload.receiver_role).toBe("parent");
					return {
						id: "msg-1",
						message: payload.message,
						deliveryStatus: "queued",
						target: { activeSessionId: "a1", sessionId: "s1" },
					};
				},
			},
		});
		servers.push(bridge);

		const runner = new CellRunner({
			cwd,
			workspaceDir: workspace,
			wasmedgeBin: toolchain!.wasmedgeBin,
			cargoBin: toolchain!.cargoBin,
			cellTimeoutMs: 120_000,
			bridge,
		});

		// mkdir cwd only after the runner exists so realpath has a target.
		const { mkdirSync } = await import("node:fs");
		mkdirSync(cwd, { recursive: true });

		const result: CellResult = await runner.execute({ code: CELL_CODE }, { cellId: "int-cell-1" });

		expect(result.stderr).toBe("");
		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("echo=42");
		expect(result.stdout).toContain("spawned=child-7");
		expect(result.stdout).toContain("delivery=queued");
		expect(result.stdout).toContain('missing-err=host request type "missing.type" is not available');

		expect(seenTypes).toEqual(["test.echo", "rlm.run", "agent_message.send"]);
		expect(echoCellSource).toContain("fn main()");

		expect(result.diffs).toEqual([{ path: "demo.txt", oldStr: "old", newStr: "new" }]);
		expect(result.sentAgentMessages).toEqual([
			{
				id: "msg-1",
				message: "hello from the sandbox",
				deliveryStatus: "queued",
				receiverRole: "parent",
				target: { activeSessionId: "a1", sessionId: "s1" },
			},
		]);

		// The scope closed with the cell: a second cell reuses the same bridge.
		const second = await runner.execute(
			{
				code: `use agent_lib::prelude::*;\nfn main() -> Result<()> {\n    let r = rlm::host_request("test.echo", serde_json::json!({"n": 1}))?;\n    println!("second={}", r["n"]);\n    Ok(())\n}\n`,
			},
			{ cellId: "int-cell-2" },
		);
		expect(second.status).toBe("ok");
		expect(second.stdout).toContain("second=2");
	});
});
