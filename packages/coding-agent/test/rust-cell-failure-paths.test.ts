/** The cell pipeline's failure paths under the real toolchain (DESIGN.md §9
 * integration row): compile errors with lib rollback, panics, timeouts, and
 * mid-run aborts. Skipped without the Rust/WasmEdge toolchain + warm template. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
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
		const mainPath = join(workspace, "cell", "src", "main.rs");
		const modPath = join(workspace, "agent_lib", "src", "helpers", "mod.rs");
		const customMod = 'pub fn healthy() -> &\'static str { "healthy" }\n';
		writeFileSync(modPath, customMod);
		const code = 'fn main() { println!("{}", agent_lib::helpers::healthy()); }';
		const assertRebuilds = () => {
			expect(readFileSync(mainPath, "utf-8")).toBe(code);
			expect(readFileSync(modPath, "utf-8")).toBe(customMod);
			execFileSync(toolchain!.cargoBin, ["build", "--release", "--offline", "-p", "cell"], {
				cwd: workspace,
				stdio: "pipe",
			});
		};

		// Baseline: the clone compiles and runs.
		const ok = await runner.execute({ code });
		expect(ok.status).toBe("ok");
		expect(ok.stdout).toContain("healthy");

		// Compile error: rendered rustc diagnostics come back, nothing runs.
		const compileError = await runner.execute({ code: 'fn main() { let x: i32 = "not a number"; }' });
		expect(compileError.status).toBe("compile_error");
		expect(compileError.compileDiagnostics).toContain("mismatched types");
		assertRebuilds();

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
		assertRebuilds();
		const helperBroken = await runner.execute({
			code: "fn main() {}",
			lib: [{ path: "src/helpers/broken.rs", content: "pub fn broken( {" }],
		});
		expect(helperBroken.status).toBe("compile_error");
		assertRebuilds();

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

	it("stops a running guest and queued cells before restarting the workspace", { timeout: 180_000 }, async () => {
		const { cwd, workspace } = makeWorkspace();
		const provisioner = new RustCellProvisioner({ cwd, workspaceDir: workspace, cellTimeoutMs: 120_000 });
		const emergency = new AbortController();
		try {
			const runner = await provisioner.ensure();
			let ready!: () => void;
			const running = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const code =
				'use std::io::Write; fn main() { println!("running"); std::io::stdout().flush().unwrap(); loop { std::hint::spin_loop(); } }';
			let output = "";
			const active = runner.execute(
				{ code },
				{
					signal: emergency.signal,
					onChunk: (chunk, stream) => {
						if (stream === "stdout") output += chunk;
						if (output.includes("running")) ready();
					},
				},
			);
			const queued = runner.execute(
				{ code: 'fn main() { std::fs::write("/workspace/queued", "ran").unwrap(); }' },
				{ signal: emergency.signal },
			);
			await Promise.race([
				running,
				active.then((result) => {
					throw new Error(`Guest exited before readiness: ${JSON.stringify(result)}`);
				}),
			]);
			await provisioner.dispose();
			expect(await active).toMatchObject({ status: "aborted", stdout: "running\n" });
			expect(await queued).toMatchObject({ status: "aborted", compileMs: 0, runMs: 0, libApplied: false });
			expect(existsSync(join(cwd, "queued"))).toBe(false);
			expect(readFileSync(join(workspace, "cell/src/main.rs"), "utf8")).toBe(code);
			const restarted = await provisioner.ensure();
			expect(restarted).not.toBe(runner);
			const result = await restarted.execute({ code: 'fn main() { println!("restarted"); }' });
			expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
			expect(result.stdout.trim()).toBe("restarted");
		} finally {
			emergency.abort();
			await provisioner.dispose();
		}
	});
});
