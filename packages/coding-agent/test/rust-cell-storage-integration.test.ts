import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import { inspectWorkspaceStorage } from "../src/core/rust-cell/storage.js";
import { inspectArtifactsStorage } from "../src/core/rust-cell/storage-inventory.js";
import { isTemplateWarm, resolveToolchain } from "../src/core/rust-cell/toolchain.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("storage maintenance with Cargo and WasmEdge", () => {
	it("rebuilds offline after pruning while retaining the library, state and Git history", {
		timeout: 180_000,
	}, async () => {
		const root = mkdtempSync(join(tmpdir(), "storage-runtime-"));
		const artifacts = join(root, "session-artifacts");
		const workspace = join(artifacts, "session", "workspace");
		const runtime = new RustCellProvisioner({ cwd: root, workspaceDir: workspace, cellTimeoutMs: 120_000 });
		try {
			const runner = await runtime.ensure();
			const initial = await runner.execute({
				code: 'fn main() { std::fs::write("/agent/state/keep", b"retained").unwrap(); println!("{}", agent_lib::helpers::storage_test::answer()); }',
				lib: [{ path: "src/helpers/storage_test.rs", content: "pub fn answer() -> i32 { 42 }" }],
			});
			expect(initial.status, initial.stderr).toBe("ok");
			await expect(inspectWorkspaceStorage(workspace, { pruneCache: true, apply: true })).rejects.toThrow(
				"Workspace is in use",
			);
			await runtime.dispose();
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
			const lib = readFileSync(join(workspace, "agent_lib/src/helpers/storage_test.rs"), "utf8");
			const pruned = await inspectArtifactsStorage(artifacts, { pruneCache: true, apply: true });
			expect(pruned.complete).toBe(true);
			expect(pruned.workspaces).toHaveLength(1);
			expect(pruned.workspaces[0]).toMatchObject({ status: "ok", report: { prune: { applied: true } } });
			expect(existsSync(join(workspace, "target"))).toBe(false);
			expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" })).toBe(head);
			expect(readFileSync(join(workspace, "agent_lib/src/helpers/storage_test.rs"), "utf8")).toBe(lib);
			const resumed = await runtime.ensure();
			const result = await resumed.execute({
				code: 'fn main() { assert_eq!(std::fs::read("/agent/state/keep").unwrap(), b"retained"); println!("{}", agent_lib::helpers::storage_test::answer()); }',
			});
			expect(result.status, result.stderr).toBe("ok");
			expect(result.stdout.trim()).toBe("42");
		} finally {
			await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
