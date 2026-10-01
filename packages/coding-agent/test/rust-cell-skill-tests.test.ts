import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { testRustSkill } from "../src/core/rust-cell/skill-tests.js";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo } from "../src/core/rust-cell/toolchain.js";
import { ensureWorkspaceAt, syncRustSkills } from "../src/core/rust-cell/workspace.js";

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
    std::fs::write("/scratch/result", "ok").unwrap();
}`;
		const f = fixture(source);
		mkdirSync(join(f.cratePath, "tests"));
		const integration = join(f.cratePath, "tests/integration.rs");
		writeFileSync(integration, "#[test] fn integration() { assert_eq!(example::value(), 42); }");
		writeFileSync(join(f.workspace, "cell/src/main.rs"), "not compilable cell source");
		await expect(testRustSkill(reference, f.options)).resolves.toBeUndefined();
		expect(readFileSync(join(f.workspace, "cell/src/main.rs"), "utf8")).toBe("not compilable cell source");
		expect(readFileSync(join(f.cratePath, "src/lib.rs"), "utf8")).toBe(source);
		expect(existsSync(join(f.root, "result"))).toBe(false);
		writeFileSync(integration, '#[test] fn integration() { panic!("integration failure"); }');
		await expect(testRustSkill(reference, f.options)).rejects.toThrow(
			/sandboxed skill tests failed.*integration failure/s,
		);
	});

	it("rejects failing assertions, compile errors, and crates without active tests", { timeout: 180_000 }, async () => {
		const f = fixture("#[test] fn fails() { assert_eq!(1, 2); }");
		await expect(testRustSkill(reference, f.options)).rejects.toThrow(/sandboxed skill tests failed/);
		writeFileSync(join(f.cratePath, "src/lib.rs"), '#[test] fn broken() { let _: u32 = "wrong"; }');
		await expect(testRustSkill(reference, f.options)).rejects.toThrow(/skill test build failed/);
		writeFileSync(join(f.cratePath, "src/lib.rs"), "#[test] #[ignore] fn ignored() {}");
		await expect(testRustSkill(reference, f.options)).rejects.toThrow(/at least one passing/);
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
