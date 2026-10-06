import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import * as cellProcess from "../src/core/rust-cell/process.js";
import { testRustSkill } from "../src/core/rust-cell/skill-tests.js";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo } from "../src/core/rust-cell/toolchain.js";
import { ensureWorkspaceAt, syncRustSkills } from "../src/core/rust-cell/workspace.js";
import { socketClient } from "./fixtures/rust-cell-network.js";

let toolchain: ToolchainInfo | undefined;
try {
	toolchain = resolveToolchain();
} catch {
	toolchain = undefined;
}
const available = toolchain !== undefined && isTemplateWarm();
const reference = { type: "rust", use: "agent_lib::skills::example" };

describe.skipIf(!available)("sandboxed skill tests", () => {
	const tempDirs: string[] = [];
	afterAll(() => {
		for (const path of tempDirs) rmSync(path, { recursive: true, force: true });
	});
	function fixture(source: string) {
		const root = mkdtempSync(join(tmpdir(), "skill-test-fixture-"));
		tempDirs.push(root);
		const workspace = ensureWorkspaceAt(join(root, "workspace"));
		const cratePath = join(root, "example");
		mkdirSync(join(cratePath, "src"), { recursive: true });
		const cargoTomlPath = join(cratePath, "Cargo.toml");
		writeFileSync(cargoTomlPath, '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2021"\n');
		writeFileSync(join(cratePath, "src/lib.rs"), source);
		syncRustSkills(workspace, [{ name: "example", crateName: "example", cratePath, cargoTomlPath }]);
		return {
			root,
			cratePath,
			workspace,
			options: {
				workspaceDir: workspace,
				cargoBin: toolchain!.cargoBin,
				wasmedgeBin: toolchain!.wasmedgeBin,
				timeoutMs: 120_000,
			},
		};
	}

	it("runs WASI unit and integration tests with only disposable scratch access", { timeout: 180_000 }, async () => {
		const source = `pub fn value() -> u32 { 42 }
#[test] fn sandbox() {
    assert_eq!(std::env::consts::ARCH, "wasm32");
    assert_eq!(value(), 42);
    for path in ["/workspace/marker", "/agent/state/marker", "/agent/harness/marker", "/agent/harness-global/marker"] {
        assert!(std::fs::write(path, "changed").is_err());
    }
    assert!(std::env::var("RLM_BRIDGE_ADDR").is_err());
    assert!(std::env::var("RLM_BRIDGE_STDIO").is_err());
    std::fs::write("/scratch/result", "ok").unwrap();
}`;
		const f = fixture(source);
		mkdirSync(join(f.cratePath, "tests"));
		const integration = join(f.cratePath, "tests/integration.rs");
		writeFileSync(integration, "#[test] fn integration() { assert_eq!(example::value(), 42); }");
		writeFileSync(join(f.workspace, "cell/src/main.rs"), "not compilable cell source");
		const incompleteSource = join(f.workspace, "skills/incomplete/src/lib.rs");
		mkdirSync(join(incompleteSource, ".."), { recursive: true });
		writeFileSync(incompleteSource, "unfinished child skill without a manifest");
		const unmounted = join(f.workspace, "skills/unmounted");
		mkdirSync(join(unmounted, "src"), { recursive: true });
		writeFileSync(join(unmounted, "Cargo.toml"), "[package\n");
		writeFileSync(join(unmounted, "src/lib.rs"), "not Rust");
		const processes = vi.spyOn(cellProcess, "runProcess");
		try {
			await expect(testRustSkill(reference, f.options)).resolves.toBeUndefined();
			const executions = processes.mock.calls.filter(([bin]) => bin === toolchain!.wasmedgeBin);
			expect(executions).toHaveLength(2);
			for (const [, args] of executions) expect(args).toContain("--force-interpreter");
		} finally {
			processes.mockRestore();
		}
		expect(readFileSync(join(f.workspace, "cell/src/main.rs"), "utf8")).toBe("not compilable cell source");
		expect(readFileSync(join(f.cratePath, "src/lib.rs"), "utf8")).toBe(source);
		expect(readFileSync(incompleteSource, "utf8")).toBe("unfinished child skill without a manifest");
		expect(existsSync(join(f.root, "result"))).toBe(false);
		writeFileSync(integration, '#[test] fn integration() { panic!("integration failure"); }');
		await expect(testRustSkill(reference, f.options)).rejects.toThrow(
			/sandboxed skill tests failed.*integration failure/s,
		);
	});

	it(
		"rejects socket-capable artifacts before running any test or opening a connection",
		{ timeout: 300_000 },
		async () => {
			let connections = 0;
			const server = createServer((socket) => {
				connections++;
				socket.destroy();
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});
			try {
				const port = (server.address() as AddressInfo).port;
				const f = fixture(`${socketClient(port)}\n#[test] fn pure() { assert_eq!(2 + 2, 4); }`);
				mkdirSync(join(f.cratePath, "tests"));
				writeFileSync(join(f.cratePath, "tests/network.rs"), "#[test] fn network() { example::connect(); }");
				const project = join(f.root, "project");
				mkdirSync(project);
				const runner = new CellRunner({
					cwd: project,
					workspaceDir: f.workspace,
					cargoBin: toolchain!.cargoBin,
					wasmedgeBin: toolchain!.wasmedgeBin,
					cellTimeoutMs: 120_000,
				});
				const blocked = await runner.execute({
					code: 'fn main() { std::fs::write("/workspace/ran", "yes").unwrap(); agent_lib::skills::example::connect(); }',
				});
				expect(blocked).toMatchObject({ status: "error", runMs: 0 });
				expect(blocked.stderr).toMatch(/cell import not allowed.*sock_/);
				expect(existsSync(join(project, "ran"))).toBe(false);
				expect(connections).toBe(0);
				// Positive control: the exact artifact really connects when invoked
				// directly in stock WasmEdge, outside the cell/test import gates.
				const control = await cellProcess.runProcess(
					toolchain!.wasmedgeBin,
					[
						"run",
						"--force-interpreter",
						"--dir",
						`/workspace:${project}`,
						join(f.workspace, "target/wasm32-wasip1/release/cell.wasm"),
					],
					{ cwd: f.workspace, timeoutMs: 10_000 },
				);
				expect(control, control.stderr).toMatchObject({ exitCode: 0 });
				expect(existsSync(join(project, "ran"))).toBe(true);
				await vi.waitFor(() => expect(connections).toBe(1));
				const processes = vi.spyOn(cellProcess, "runProcess");
				try {
					await expect(testRustSkill(reference, f.options)).rejects.toThrow(
						/skill test import not allowed.*sock_/,
					);
					expect(processes.mock.calls.filter(([bin]) => bin === toolchain!.wasmedgeBin)).toHaveLength(0);
					expect(connections).toBe(1);
				} finally {
					processes.mockRestore();
				}
			} finally {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
	);

	it("rejects failing assertions, compile errors, and crates without active tests", { timeout: 180_000 }, async () => {
		const f = fixture("#[test] fn fails() { assert_eq!(1, 2); }");
		await expect(testRustSkill(reference, f.options)).rejects.toThrow(/sandboxed skill tests failed/);
		writeFileSync(join(f.cratePath, "src/lib.rs"), '#[test] fn broken() { let _: u32 = "wrong"; }');
		await expect(testRustSkill(reference, f.options)).rejects.toThrow(/skill test build failed/);
		writeFileSync(join(f.cratePath, "src/lib.rs"), "#[test] #[ignore] fn ignored() {}");
		await expect(testRustSkill(reference, f.options)).rejects.toThrow(/at least one passing/);
	});

	it("rejects live source edits while the snapshot tests are running", { timeout: 180_000 }, async () => {
		const f = fixture("pub fn value() -> u32 { 42 }\n#[test] fn answer() { assert_eq!(value(), 42); }");
		const original = cellProcess.runProcess;
		const processes = vi.spyOn(cellProcess, "runProcess").mockImplementation(async (bin, args, options) => {
			const result = await original(bin, args, options);
			if (bin === toolchain!.wasmedgeBin) {
				writeFileSync(join(f.cratePath, "src/lib.rs"), "pub fn value() -> u32 { 43 }");
			}
			return result;
		});
		try {
			await expect(testRustSkill(reference, f.options)).rejects.toThrow("changed during testing");
		} finally {
			processes.mockRestore();
		}
	});

	it("bounds hanging tests and propagates cancellation", { timeout: 180_000 }, async () => {
		const f = fixture("#[test] fn hangs() { loop { std::hint::black_box(1); } }");
		await expect(testRustSkill(reference, { ...f.options, timeoutMs: 10_000 })).rejects.toThrow(/timed out/);
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(new Error("user cancelled")), 2000);
		try {
			await expect(testRustSkill(reference, { ...f.options, signal: abort.signal })).rejects.toThrow(
				"user cancelled",
			);
		} finally {
			clearTimeout(timer);
		}
	});

	it("rejects unmounted crates and invalid reference paths", async () => {
		const f = fixture("#[test] fn works() {}");
		const unmounted = join(f.workspace, "skills/unmounted");
		mkdirSync(join(unmounted, "src"), { recursive: true });
		writeFileSync(join(unmounted, "Cargo.toml"), '[package]\nname = "unmounted"\nversion = "0.1.0"\n');
		writeFileSync(join(unmounted, "src/lib.rs"), "#[test] fn works() {}");
		await expect(testRustSkill({ ...reference, use: "agent_lib::skills::unmounted" }, f.options)).rejects.toThrow(
			"not mounted",
		);
		await expect(testRustSkill({ ...reference, use: "agent_lib::skills::missing" }, f.options)).rejects.toThrow(
			"not mounted",
		);
		await expect(testRustSkill({ ...reference, use: "../../outside" }, f.options)).rejects.toThrow(
			"require an agent_lib",
		);
	});

	it("enforces gas and memory limits in skill test modules", { timeout: 180_000 }, async () => {
		const f = fixture("#[test] fn hangs() { loop { std::hint::black_box(1); } }");
		await expect(testRustSkill(reference, { ...f.options, cellGasLimit: 1_000_000 })).rejects.toThrow(
			/cost (?:exceeded limit|limit exceeded)/i,
		);
		writeFileSync(
			join(f.cratePath, "src/lib.rs"),
			`#[test] fn memory_limit() {
    assert_eq!(std::arch::wasm32::memory_grow::<0>(128), usize::MAX);
}`,
		);
		await expect(testRustSkill(reference, { ...f.options, cellMemoryPageLimit: 128 })).resolves.toBeUndefined();
		await expect(testRustSkill(reference, f.options)).rejects.toThrow(/sandboxed skill tests failed/);
	});
});
