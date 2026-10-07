import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDependencyHandler } from "../src/core/rust-cell/dependencies.js";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import { isTemplateWarm, resolveToolchain } from "../src/core/rust-cell/toolchain.js";
import { ensureWorkspaceAt, resolveTemplateDir, syncRustSkills } from "../src/core/rust-cell/workspace.js";

const CANARY = "WASMEDGE_AGENT_TEST_BUILD_CANARY";
const SECRET = "test-only-build-canary";
let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("Cargo environment with real compiler and WasmEdge", () => {
	const roots: string[] = [];
	const provisioners: RustCellProvisioner[] = [];
	afterEach(async () => {
		for (const provisioner of provisioners.splice(0)) await provisioner.dispose();
		vi.unstubAllEnvs();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	function fixture() {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "cargo-env-real-")));
		roots.push(root);
		vi.stubEnv(CANARY, SECRET);
		vi.stubEnv("OPENAI_API_KEY", "test-only-provider-key");
		vi.stubEnv("CARGO_NET_OFFLINE", "true");
		const workspace = join(root, "workspace");
		const provisioner = new RustCellProvisioner({ cwd: root, workspaceDir: workspace, cellTimeoutMs: 180_000 });
		provisioners.push(provisioner);
		return { root, workspace, provisioner };
	}
	it("removes inherited values from cells and previously compiled libraries", { timeout: 180_000 }, async () => {
		const { workspace, provisioner } = fixture();
		ensureWorkspaceAt(workspace);
		const lib = join(workspace, "agent_lib/src/lib.rs");
		writeFileSync(
			lib,
			`${readFileSync(lib, "utf-8")}\npub fn prior_env() -> Option<&'static str> { option_env!("${CANARY}") }\n`,
		);
		writeFileSync(
			join(workspace, "cell/src/main.rs"),
			`fn main() { assert_eq!(agent_lib::prior_env(), Some("${SECRET}")); }`,
		);
		// Positive control uses only a fake canary. Compile it before enabling the
		// runtime policy to also exercise Cargo's cached env! dependency tracking.
		const toolchain = resolveToolchain();
		execFileSync(toolchain.cargoBin, ["build", "--release", "--offline", "-p", "cell"], {
			cwd: workspace,
			stdio: "pipe",
		});
		execFileSync(
			toolchain.wasmedgeBin,
			["run", "--force-interpreter", join(workspace, "target/wasm32-wasip1/release/cell.wasm")],
			{ stdio: "pipe" },
		);
		const runner = await provisioner.ensure();
		const result = await runner.execute({
			code: `fn main() {
            assert!(option_env!("${CANARY}").is_none());
            assert!(option_env!("OPENAI_API_KEY").is_none());
            assert!(agent_lib::prior_env().is_none());
            println!("environment filtered");
        }`,
		});
		expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
		expect(result.stdout.trim()).toBe("environment filtered");
		const required = await runner.execute({ code: `fn main() { println!("{}", env!("${CANARY}")); }` });
		expect(required.status).toBe("compile_error");
		expect(required.compileDiagnostics).toContain(CANARY);
		expect(required.compileDiagnostics).not.toContain(SECRET);
		expect(process.env[CANARY]).toBe(SECRET);
		expect(process.env.OPENAI_API_KEY).toBe("test-only-provider-key");
	});
	it("filters skill probes, build scripts, and sandboxed test compilation", { timeout: 180_000 }, async () => {
		const { root, workspace, provisioner } = fixture();
		const runner = await provisioner.ensure();
		const skill = join(root, "guard");
		mkdirSync(join(skill, "src"), { recursive: true });
		writeFileSync(join(skill, "Cargo.toml"), '[package]\nname="guard"\nversion="0.1.0"\nedition="2021"\n');
		writeFileSync(
			join(skill, "build.rs"),
			`fn main() { assert!(std::env::var_os("${CANARY}").is_none()); assert!(std::env::var_os("OPENAI_API_KEY").is_none()); }`,
		);
		writeFileSync(
			join(skill, "src/lib.rs"),
			`pub fn hidden() -> bool { option_env!("${CANARY}").is_none() }
            #[test] fn test_environment() { assert!(hidden()); assert!(option_env!("OPENAI_API_KEY").is_none()); }
        `,
		);
		const mounted = syncRustSkills(
			workspace,
			[{ name: "guard", crateName: "guard", cratePath: skill, cargoTomlPath: join(skill, "Cargo.toml") }],
			{ cargoBin: provisioner.toolchain!.cargoBin },
		);
		expect(mounted.failed).toEqual([]);
		expect(mounted.mounted).toEqual(["guard"]);
		await expect(provisioner.testSkill({ type: "rust", use: "agent_lib::skills::guard" })).resolves.toBeUndefined();
		const result = await runner.execute({ code: "fn main() { assert!(agent_lib::skills::guard::hidden()); }" });
		expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
	});
	it("filters template preparation, scaffold upgrades and dependency subprocesses", { timeout: 300_000 }, async () => {
		const { root, workspace, provisioner } = fixture();
		const cargoBin = resolveToolchain().cargoBin;
		const template = resolveTemplateDir();
		const coldTemplate = join(root, "template");
		cpSync(template, coldTemplate, {
			recursive: true,
			filter: (path) => !["target", "vendor"].includes(relative(template, path).split(sep)[0]),
		});
		const wrapper = join(root, "cargo.cjs");
		const log = join(root, "calls.jsonl");
		writeFileSync(
			wrapper,
			`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.env[${JSON.stringify(CANARY)}] !== undefined || process.env.OPENAI_API_KEY !== undefined) {
    throw new Error('Cargo inherited non-allowlisted values');
}
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const result = spawnSync(${JSON.stringify(cargoBin)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
			{ mode: 0o755 },
		);
		vi.stubEnv("WASMEDGE_AGENT_CARGO", wrapper);
		vi.stubEnv("WASMEDGE_AGENT_TEMPLATE_DIR", coldTemplate);
		await provisioner.ensure();
		await provisioner.dispose();
		const configured = [{ name: "itoa", version: "1.0.18" }];
		const upgraded = new RustCellProvisioner({ cwd: root, workspaceDir: workspace, preludeExtra: configured });
		provisioners.push(upgraded);
		await upgraded.ensure();
		// A missing vendored source forces the dependency fetch path. Cargo's
		// local cache supplies it; the whole test keeps CARGO_NET_OFFLINE=true.
		rmSync(join(workspace, "vendor/base64"), { recursive: true });
		const add = createDependencyHandler({
			workspace,
			template: coldTemplate,
			cargoBin: wrapper,
			configured,
			timeoutMs: 180_000,
		});
		await add({ crate_name: "base64" }, { signal: new AbortController().signal });
		const calls = readFileSync(log, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { args: string[]; cwd: string });
		expect(calls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					args: ["vendor", "--locked", expect.stringContaining(join(coldTemplate, "vendor.tmp-"))],
					cwd: coldTemplate,
				}),
				expect.objectContaining({ args: ["build", "--release", "-p", "cell"], cwd: coldTemplate }),
				expect.objectContaining({ args: ["vendor", "vendor"] }),
				expect.objectContaining({ args: ["metadata", "--offline", "--format-version", "1"] }),
				expect.objectContaining({ args: ["vendor", "--no-delete", "vendor"] }),
			]),
		);
		// Upgrade validation and dependency validation must both build.
		expect(calls.filter(({ args }) => args.join(" ") === "build --release --offline -p cell")).toHaveLength(2);
	});
});
