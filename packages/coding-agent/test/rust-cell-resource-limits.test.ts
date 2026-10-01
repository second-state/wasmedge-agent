import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import { type CellResourceLimits, wasmedgeResourceArgs } from "../src/core/rust-cell/resource-limits.js";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo } from "../src/core/rust-cell/toolchain.js";
import { ensureWorkspaceAt } from "../src/core/rust-cell/workspace.js";
import { createRustTool } from "../src/core/tools/rust.js";

describe("resource limit validation", () => {
	it("retains runtime defaults and accepts the supported CLI boundaries", () => {
		expect(wasmedgeResourceArgs({})).toEqual([]);
		expect(wasmedgeResourceArgs({ cellGasLimit: null, cellMemoryPageLimit: null })).toEqual([]);
		expect(wasmedgeResourceArgs({ cellGasLimit: 0xffff_ffff, cellMemoryPageLimit: 65_536 })).toEqual([
			"--gas-limit",
			"4294967295",
			"--memory-page-limit",
			"65536",
		]);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 0.5, 0x1_0000_0000])(
		"rejects invalid SDK limits before provisioning: %s",
		(cellGasLimit) => {
			expect(() => new RustCellProvisioner({ cwd: "/unused", cellGasLimit })).toThrow("rustCell.cellGasLimit");
			expect(() => createRustTool("/unused", { cellGasLimit })).toThrow("rustCell.cellGasLimit");
		},
	);
});

let toolchain: ToolchainInfo | undefined;
try {
	toolchain = resolveToolchain();
} catch {}

describe.skipIf(!toolchain || !isTemplateWarm())("resource limits in real WasmEdge cells", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});
	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "cell-limits-"));
		roots.push(root);
		const workspaceDir = ensureWorkspaceAt(join(root, "workspace"));
		return (limits: CellResourceLimits = {}) =>
			new CellRunner({
				cwd: root,
				workspaceDir,
				cargoBin: toolchain!.cargoBin,
				wasmedgeBin: toolchain!.wasmedgeBin,
				cellTimeoutMs: 120_000,
				...limits,
			});
	}

	it("stops an infinite loop on gas exhaustion while allowing work within budget", { timeout: 180_000 }, async () => {
		const runner = fixture()({ cellGasLimit: 1_000_000 });
		const ok = await runner.execute({ code: 'fn main() { println!("within budget"); }' });
		expect(ok.status, ok.stderr).toBe("ok");
		const exhausted = await runner.execute({ code: "fn main() { loop { std::hint::black_box(1); } }" });
		expect(exhausted.status, exhausted.stderr).toBe("error");
		expect(`${exhausted.stdout}\n${exhausted.stderr}`).toMatch(/cost (?:exceeded limit|limit exceeded)/i);
	});

	it("bounds memory growth and reports initialization failures under a small cap", { timeout: 180_000 }, async () => {
		const runner = fixture();
		const code = `fn main() {
    assert_ne!(std::arch::wasm32::memory_grow::<0>(1), usize::MAX);
    let denied = std::arch::wasm32::memory_grow::<0>(64) == usize::MAX;
    println!("denied={denied}");
}`;
		const limited = await runner({ cellMemoryPageLimit: 64 }).execute({ code });
		expect(limited.status, limited.stderr).toBe("ok");
		expect(limited.stdout).toContain("denied=true");
		const unlimited = await runner().execute({ code });
		expect(unlimited.status, unlimited.stderr).toBe("ok");
		expect(unlimited.stdout).toContain("denied=false");
		const tooSmall = await runner({ cellMemoryPageLimit: 1 }).execute({
			code: 'fn main() { println!("should not run"); }',
		});
		expect(tooSmall.status, tooSmall.stderr).toBe("error");
		expect(tooSmall.stdout).not.toContain("should not run");
	});
});
