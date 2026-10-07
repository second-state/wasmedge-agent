import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import * as cellProcess from "../src/core/rust-cell/process.js";
import { resolveToolchain, type ToolchainInfo } from "../src/core/rust-cell/toolchain.js";
import type { RunnerOptions } from "../src/core/rust-cell/types.js";
import { WorkspaceHistory } from "../src/core/rust-cell/workspace-history.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createRustToolDefinition } from "../src/core/tools/rust.js";
import { socketClient } from "./fixtures/rust-cell-network.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function rootDir() {
	const root = mkdtempSync(join(tmpdir(), "library-test-gate-"));
	roots.push(root);
	return root;
}

describe("library test gate configuration", () => {
	it("defaults off and lets project settings override the global gate", () => {
		expect(SettingsManager.inMemory({}).getRustCellLibraryTestGate()).toBe(false);
		const root = rootDir();
		const agent = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agent);
		mkdirSync(join(project, ".wasmedge-agent"), { recursive: true });
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ rustCell: { libraryTestGate: true } }));
		expect(SettingsManager.create(project, agent).getRustCellLibraryTestGate()).toBe(true);
		writeFileSync(
			join(project, ".wasmedge-agent/settings.json"),
			JSON.stringify({ rustCell: { libraryTestGate: false } }),
		);
		expect(SettingsManager.create(project, agent).getRustCellLibraryTestGate()).toBe(false);
	});

	it.each([null, "true", "false", 0, 1, {}])("rejects malformed gate %j before provisioning", (invalid) => {
		const libraryTestGate = invalid as boolean;
		expect(() => SettingsManager.inMemory({ rustCell: { libraryTestGate } }).getRustCellLibraryTestGate()).toThrow(
			"rustCell.libraryTestGate must be a boolean",
		);
		expect(() => new RustCellProvisioner({ cwd: "/unused", libraryTestGate })).toThrow("rustCell.libraryTestGate");
		expect(() => createRustToolDefinition("/unused", { libraryTestGate })).toThrow("rustCell.libraryTestGate");
		expect(
			() =>
				new CellRunner({
					cwd: "/unused",
					workspaceDir: "/unused",
					cargoBin: "unused",
					wasmedgeBin: "unused",
					cellTimeoutMs: 1000,
					libraryTestGate,
				}),
		).toThrow("rustCell.libraryTestGate");
	});

	it("describes the shared runtime's fixed gate even when SDK options disagree", () => {
		const options = { cwd: "/unused", libraryTestGate: true };
		const provisioner = new RustCellProvisioner(options);
		options.libraryTestGate = false;
		expect(provisioner.libraryTestGate).toBe(true);
		expect(createRustToolDefinition("/unused", { provisioner, libraryTestGate: false }).description).toContain(
			"Library test gate is enabled",
		);
		expect(createRustToolDefinition("/unused").description).not.toContain("Library test gate is enabled");
	});
});

let toolchain: ToolchainInfo | undefined;
try {
	toolchain = resolveToolchain();
} catch {}
const available = toolchain !== undefined;
const helperPath = "src/helpers/checked.rs";
const passing = "pub fn value() -> u32 { 42 }\n#[test] fn answer() { assert_eq!(value(), 42); }";
const code =
	'fn main() { assert_eq!(agent_lib::helpers::checked::value(), 42); std::fs::write("/workspace/ran", "yes").unwrap(); }';

describe.skipIf(!available)("library test gate with Cargo and WasmEdge", () => {
	async function fixture(overrides: Partial<RunnerOptions> = {}) {
		const root = rootDir();
		const cwd = join(root, "project");
		mkdirSync(cwd);
		const workspace = join(root, "workspace");
		for (const path of [".cargo", "cell/src", "agent_lib/src/helpers"]) {
			mkdirSync(join(workspace, path), { recursive: true });
		}
		writeFileSync(
			join(workspace, "Cargo.toml"),
			'[workspace]\nmembers = ["agent_lib", "cell"]\nresolver = "2"\n[profile.dev.package."*"]\ndebug = false\n',
		);
		writeFileSync(join(workspace, ".cargo/config.toml"), '[build]\ntarget = "wasm32-wasip1"\nbuild-dir = "target"\n');
		writeFileSync(
			join(workspace, "agent_lib/Cargo.toml"),
			'[package]\nname = "agent_lib"\nversion = "0.1.0"\nedition = "2021"\n',
		);
		writeFileSync(
			join(workspace, "cell/Cargo.toml"),
			'[package]\nname = "cell"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nagent_lib = { path = "../agent_lib" }\n',
		);
		writeFileSync(join(workspace, "agent_lib/src/lib.rs"), "pub mod helpers;\n");
		const main = join(workspace, "cell/src/main.rs");
		const index = join(workspace, "agent_lib/src/helpers/mod.rs");
		writeFileSync(main, "fn main() {}\n");
		writeFileSync(index, "// No helpers yet.\n");
		execFileSync(toolchain!.cargoBin, ["generate-lockfile", "--offline"], { cwd: workspace, stdio: "pipe" });
		const originalMain = readFileSync(main, "utf8");
		const originalIndex = readFileSync(index, "utf8");
		const history = new WorkspaceHistory(workspace);
		await history.ensure();
		const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
		const originalHead = head();
		const runner = new CellRunner({
			cwd,
			workspaceDir: workspace,
			cargoBin: toolchain!.cargoBin,
			wasmedgeBin: toolchain!.wasmedgeBin,
			cellTimeoutMs: 120_000,
			libraryTestGate: true,
			history,
			...overrides,
		});
		const unchanged = () => {
			expect(existsSync(join(cwd, "ran"))).toBe(false);
			expect(existsSync(join(workspace, "agent_lib", helperPath))).toBe(false);
			expect(readFileSync(main, "utf8")).toBe(originalMain);
			expect(readFileSync(index, "utf8")).toBe(originalIndex);
			expect(head()).toBe(originalHead);
		};
		return { root, cwd, workspace, runner, unchanged, head };
	}

	it("tests staged unit/integration code before publishing and committing a successful cell", {
		timeout: 180_000,
	}, async () => {
		const f = await fixture();
		mkdirSync(join(f.workspace, "agent_lib/tests"));
		writeFileSync(
			join(f.workspace, "agent_lib/tests/regression.rs"),
			"#[test] fn value() { assert_eq!(agent_lib::helpers::checked::value(), 42); }",
		);
		const source = `${passing}
#[test] fn sandbox() {
    assert_eq!(std::env::consts::ARCH, "wasm32");
    for path in ["/workspace/ran", "/agent/state/marker", "/agent/harness/marker", "/agent/harness-global/marker"] {
        assert!(std::fs::write(path, "changed").is_err());
    }
    for key in ["RLM_BRIDGE_STDIO", "RLM_BRIDGE_TOKEN", "RLM_CELL_ID"] {
        assert!(std::env::var(key).is_err());
    }
    std::fs::write("/scratch/result", "ok").unwrap();
}`;
		const runProcess = cellProcess.runProcess;
		let tested = 0;
		const processes = vi.spyOn(cellProcess, "runProcess").mockImplementation(async (bin, args, options) => {
			if (args.includes("--test-threads=1")) {
				f.unchanged();
				expect(args).toContain("--force-interpreter");
				tested++;
			}
			return runProcess(bin, args, options);
		});
		const result = await f.runner.execute({ code, lib: [{ path: helperPath, content: source }] });
		expect(result, result.stderr).toMatchObject({ status: "ok", libApplied: true, libReverted: false });
		expect(tested).toBe(2);
		expect(readFileSync(join(f.workspace, "agent_lib", helperPath), "utf8")).toBe(source);
		expect(existsSync(join(f.cwd, "ran"))).toBe(true);
		expect(result.workspaceCommit).toBe(f.head());
		processes.mockRestore();
		rmSync(join(f.cwd, "ran"));
		const rejected = await f.runner.execute({
			code,
			lib: [{ path: helperPath, content: passing.replaceAll("42", "43") }],
		});
		expect(rejected).toMatchObject({ status: "error", libApplied: false, runMs: 0 });
		expect(rejected.stderr).toContain("sandboxed library tests failed");
		expect(readFileSync(join(f.workspace, "agent_lib", helperPath), "utf8")).toBe(source);
		expect(readFileSync(join(f.workspace, "cell/src/main.rs"), "utf8")).toBe(code);
		expect(existsSync(join(f.cwd, "ran"))).toBe(false);
		expect(f.head()).toBe(result.workspaceCommit);
	});

	it.each([
		{
			name: "failing assertions",
			source: '#[test] fn bad() { panic!("regression"); }',
			error: "sandboxed library tests failed",
		},
		{
			name: "test compile errors",
			source: '#[test] fn bad() { let _: u32 = "wrong"; }',
			error: "library test build failed",
		},
		{ name: "no tests", source: "pub fn value() -> u32 { 42 }", error: "at least one passing" },
		{ name: "only ignored tests", source: "#[test] #[ignore] fn skipped() {}", error: "at least one passing" },
		{
			name: "network imports",
			source: `${socketClient(9)}\n#[test] fn network() { connect(); }`,
			error: "library test import not allowed",
		},
	])("rejects $name without publishing edits or running the cell", { timeout: 180_000 }, async ({ source, error }) => {
		const f = await fixture();
		const result = await f.runner.execute({ code, lib: [{ path: helperPath, content: source }] });
		expect(result).toMatchObject({ status: "error", libApplied: false, libReverted: false, runMs: 0 });
		expect(result.stderr).toContain(error);
		f.unchanged();
	});

	it("keeps the default compile-only path and allows cells without lib edits under the gate", {
		timeout: 180_000,
	}, async () => {
		const disabled = await fixture({ libraryTestGate: undefined });
		const withoutTests = await disabled.runner.execute({
			code,
			lib: [{ path: helperPath, content: "pub fn value() -> u32 { 42 }" }],
		});
		expect(withoutTests, withoutTests.stderr).toMatchObject({ status: "ok" });
		const enabled = await fixture();
		const cellOnly = await enabled.runner.execute({ code: "fn main() {}", lib: [] });
		expect(cellOnly, cellOnly.stderr).toMatchObject({ status: "ok" });
	});

	it("restores source edits if the cell fails to compile after library tests pass", { timeout: 180_000 }, async () => {
		const f = await fixture();
		const result = await f.runner.execute({
			code: "fn main() { missing(); }",
			lib: [{ path: helperPath, content: passing }],
		});
		expect(result).toMatchObject({ status: "compile_error", libReverted: true, runMs: 0 });
		f.unchanged();
	});

	it.each(["live", "snapshot"])(
		"rejects %s source changes during validation",
		{ timeout: 180_000 },
		async (changed) => {
			const f = await fixture();
			const runProcess = cellProcess.runProcess;
			vi.spyOn(cellProcess, "runProcess").mockImplementation(async (bin, args, options) => {
				const result = await runProcess(bin, args, options);
				if (args.includes("--test-threads=1")) {
					const path = join(changed === "live" ? f.workspace : options.cwd, "agent_lib/src/lib.rs");
					writeFileSync(path, `${readFileSync(path, "utf8")}\n// concurrent edit\n`);
				}
				return result;
			});
			const result = await f.runner.execute({ code, lib: [{ path: helperPath, content: passing }] });
			expect(result).toMatchObject({ status: "error", libApplied: false, runMs: 0 });
			expect(result.stderr).toContain("changed during testing");
			f.unchanged();
		},
	);

	it("keeps the submitted cell and library immutable while validation is in flight", {
		timeout: 180_000,
	}, async () => {
		const f = await fixture();
		const input = { code, lib: [{ path: helperPath, content: passing }] };
		const runProcess = cellProcess.runProcess;
		vi.spyOn(cellProcess, "runProcess").mockImplementation(async (bin, args, options) => {
			const result = await runProcess(bin, args, options);
			if (args.includes("--test-threads=1")) {
				input.code = "fn main() { missing(); }";
				input.lib[0].content = "pub fn value() -> u32 { 0 }";
			}
			return result;
		});
		const result = await f.runner.execute(input);
		expect(result, result.stderr).toMatchObject({ status: "ok", libApplied: true });
		expect(readFileSync(join(f.workspace, "agent_lib", helperPath), "utf8")).toBe(passing);
		expect(readFileSync(join(f.workspace, "cell/src/main.rs"), "utf8")).toBe(code);
	});

	it("enforces gas limits on library tests", { timeout: 180_000 }, async () => {
		const f = await fixture({ cellGasLimit: 1_000_000 });
		const result = await f.runner.execute({
			code,
			lib: [{ path: helperPath, content: "#[test] fn hangs() { loop { std::hint::black_box(1); } }" }],
		});
		expect(result).toMatchObject({ status: "error", libApplied: false, runMs: 0 });
		expect(result.stderr).toMatch(/cost (?:exceeded limit|limit exceeded)/i);
		f.unchanged();
	});

	it.each(["abort", "dispose"])(
		"cancels running library tests on %s before publishing",
		{ timeout: 180_000 },
		async (mode) => {
			const f = await fixture();
			const controller = new AbortController();
			const runProcess = cellProcess.runProcess;
			let stopping: Promise<void> | undefined;
			vi.spyOn(cellProcess, "runProcess").mockImplementation((bin, args, options) =>
				runProcess(bin, args, {
					...options,
					onChunk: (chunk, stream) => {
						options.onChunk?.(chunk, stream);
						if (!chunk.includes("library-running")) return;
						if (mode === "abort") controller.abort();
						else stopping = f.runner.dispose();
					},
				}),
			);
			const result = await f.runner.execute(
				{
					code,
					lib: [
						{
							path: helperPath,
							content: '#[test] fn hangs() { println!("library-running"); loop { std::hint::black_box(1); } }',
						},
					],
				},
				{ signal: controller.signal },
			);
			expect(result).toMatchObject({ status: "aborted", libApplied: false, runMs: 0 });
			await stopping;
			f.unchanged();
		},
	);

	it("shares the cell deadline with test build and execution", { timeout: 180_000 }, async () => {
		const f = await fixture({ cellTimeoutMs: 2000 });
		const result = await f.runner.execute({
			code,
			lib: [{ path: helperPath, content: "#[test] fn hangs() { loop { std::hint::black_box(1); } }" }],
		});
		expect(result).toMatchObject({ status: "timeout", libApplied: false, runMs: 0 });
		f.unchanged();
	});
});
