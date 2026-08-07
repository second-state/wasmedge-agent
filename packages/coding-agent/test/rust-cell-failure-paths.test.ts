/** The cell pipeline's failure paths under the real toolchain (DESIGN.md §9
 * integration row): compile errors with lib rollback, panics, timeouts, and
 * mid-run aborts. Skipped without the Rust/WasmEdge toolchain + warm template. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

describe.skipIf(!available)("rust cell failure paths", () => {
	const tempDirs: string[] = [];
	afterAll(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function makeWorkspace(): { cwd: string; workspace: string } {
		const root = mkdtempSync(join(tmpdir(), "cell-failure-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		return { cwd, workspace: ensureWorkspaceAt(join(root, "workspace")) };
	}

	function makeRunner(cwd: string, workspace: string, cellTimeoutMs: number): CellRunner {
		return new CellRunner({
			cwd,
			workspaceDir: workspace,
			wasmedgeBin: toolchain?.wasmedgeBin as string,
			cargoBin: toolchain?.cargoBin as string,
			cellTimeoutMs,
		});
	}

	it("reports failures with honest statuses and reverts a broken lib", { timeout: 300_000 }, async () => {
		const { cwd, workspace } = makeWorkspace();
		const runner = makeRunner(cwd, workspace, 240_000);

		// Baseline: the clone compiles and runs.
		const ok = await runner.execute({ code: 'fn main() { println!("healthy"); }' });
		expect(ok.status).toBe("ok");
		expect(ok.stdout).toContain("healthy");

		// Compile error: rendered rustc diagnostics come back, nothing runs.
		const compileError = await runner.execute({ code: 'fn main() { let x: i32 = "not a number"; }' });
		expect(compileError.status).toBe("compile_error");
		expect(compileError.compileDiagnostics).toContain("mismatched types");

		// A lib file that breaks the build is rolled back atomically: the
		// workspace stays compilable and the old source is restored.
		const libPath = join(workspace, "agent_lib", "src", "lib.rs");
		const libBefore = readFileSync(libPath, "utf-8");
		const libBroken = await runner.execute({
			code: "fn main() {}",
			lib: [{ path: "src/lib.rs", content: "pub fn broken( {" }],
		});
		expect(libBroken.status).toBe("compile_error");
		expect(libBroken.libReverted).toBe(true);
		expect(readFileSync(libPath, "utf-8")).toBe(libBefore);
		const afterRollback = await runner.execute({ code: 'fn main() { println!("still compiles"); }' });
		expect(afterRollback.status).toBe("ok");

		// Panic: a nonzero wasm exit with the panic message on stderr.
		const panicked = await runner.execute({ code: 'fn main() { panic!("boom-marker"); }' });
		expect(panicked.status).toBe("error");
		expect(panicked.exitCode).not.toBe(0);
		expect(panicked.stderr).toContain("boom-marker");

		// Abort: cancelling mid-run surfaces as "aborted", not a crash.
		const controller = new AbortController();
		const aborting = runner.execute(
			{ code: "fn main() { loop { std::hint::spin_loop(); } }" },
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 4_000);
		const aborted = await aborting;
		expect(aborted.status).toBe("aborted");
	});

	it("charges compile and run against one budget and times out", { timeout: 300_000 }, async () => {
		const { cwd, workspace } = makeWorkspace();
		// Warm the clone's compile path first so the tight budget below is
		// spent in the run phase, not on first-compile variance.
		const warm = makeRunner(cwd, workspace, 240_000);
		expect((await warm.execute({ code: "fn main() {}" })).status).toBe("ok");

		const tight = makeRunner(cwd, workspace, 12_000);
		const spin = await tight.execute({ code: "fn main() { loop { std::hint::spin_loop(); } }" });
		expect(spin.status).toBe("timeout");
	});
});
