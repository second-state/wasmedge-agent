import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDependencyHandler } from "../src/core/rust-cell/dependencies.js";
import { CELL_DEPENDENCIES_FILE, readCellDependencies } from "../src/core/rust-cell/dependency-catalog.js";
import { DEPENDENCY_PATHS } from "../src/core/rust-cell/dependency-transaction.js";
import { RustCellProvisioner, type RustCellProvisionerOptions } from "../src/core/rust-cell/index.js";
import { isTemplateWarm, resolveToolchain } from "../src/core/rust-cell/toolchain.js";
import { resolveTemplateDir } from "../src/core/rust-cell/workspace.js";
import { WorkspaceHistory } from "../src/core/rust-cell/workspace-history.js";
import { snapshotWorkspace } from "../src/core/rust-cell/workspace-snapshot.js";

const TEMPLATE_CRATES = ["aho-corasick", "base64", "itoa", "memchr", "regex-automata", "regex-syntax"];

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("curated dependencies with Cargo and WasmEdge", () => {
	const roots: string[] = [];
	const provisioners: RustCellProvisioner[] = [];
	afterEach(async () => {
		for (const provisioner of provisioners.splice(0)) await provisioner.dispose();
		vi.unstubAllEnvs();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	function provision(options: RustCellProvisionerOptions) {
		const provisioner = new RustCellProvisioner(options);
		provisioners.push(provisioner);
		return provisioner;
	}
	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "deps-real-"));
		roots.push(root);
		return { root, workspace: join(root, "workspace") };
	}
	it(
		"adds vendored crates offline, fetches a new crate, then resumes and inherits offline",
		{ timeout: 600_000 },
		async () => {
			const { root, workspace } = fixture();
			const first = provision({ cwd: root, workspaceDir: workspace, cellTimeoutMs: 300_000 });
			const runner = await first.ensure();
			const templateManifest = readFileSync(join(resolveTemplateDir(), "Cargo.toml"), "utf-8");
			const cargoHome = join(root, "empty-cargo-home");
			mkdirSync(cargoHome);
			vi.stubEnv("CARGO_HOME", cargoHome);
			vi.stubEnv("CARGO_NET_OFFLINE", "true");
			// Keep multiple additions in one cell without six release builds sharing its deadline on CI.
			for (let offset = 0; offset < TEMPLATE_CRATES.length; offset += 2) {
				const crates = TEMPLATE_CRATES.slice(offset, offset + 2);
				const added = await runner.execute({
					code: `use agent_lib::prelude::*;
            use std::io::Write;
            fn main() -> Result<()> {
                let mut file = std::fs::File::create("/agent/state/open.txt")?;
                file.write_all(b"before,")?;
                rlm::state::set("before", &1)?;
                for name in [${crates.map((name) => JSON.stringify(name)).join(",")}] {
                    rlm::deps::add(name)?;
                }
                rlm::deps::add(${JSON.stringify(crates[0])})?;
                assert!(rlm::deps::add("reqwest").is_err());
                assert!(rlm::host_request("deps.add", json!({"crate_name":"itoa","version":"99.0.0"})).is_err());
                file.write_all(b"after")?;
                rlm::state::set("after", &2)?;
                println!("added once"); Ok(())
            }`,
				});
				expect(added.status, added.compileDiagnostics ?? added.stderr).toBe("ok");
				expect(added.stdout.trim()).toBe("added once");
				expect(readFileSync(join(workspace, "state/open.txt"), "utf-8")).toBe("before,after");
				expect(JSON.parse(readFileSync(join(workspace, "state/state.json"), "utf-8"))).toMatchObject({
					before: 1,
					after: 2,
				});
			}
			expect(readCellDependencies(workspace)).toEqual(TEMPLATE_CRATES.sort());
			const history = execFileSync("git", ["-C", workspace, "log", "--pretty=%s"], { encoding: "utf-8" });
			expect(history.match(/chore\(deps\):/g)).toHaveLength(6);
			expect(
				execFileSync("git", ["-C", workspace, "show", `HEAD:${CELL_DEPENDENCIES_FILE}`], { encoding: "utf-8" }),
			).toContain("itoa");
			// A missing crate must fail without publishing when registry access is disabled.
			const lock = readFileSync(join(workspace, "Cargo.lock"), "utf-8");
			const unavailable = await runner.execute({
				code: 'use agent_lib::prelude::*; fn main() { assert!(rlm::deps::add("hex").unwrap_err().to_string().contains("Dependency fetch failed")); }',
			});
			expect(unavailable.status, unavailable.compileDiagnostics ?? unavailable.stderr).toBe("ok");
			expect(readFileSync(join(workspace, "Cargo.lock"), "utf-8")).toBe(lock);
			expect(readCellDependencies(workspace)).toEqual([...TEMPLATE_CRATES].sort());
			expect(existsSync(join(workspace, "vendor/hex"))).toBe(false);
			vi.unstubAllEnvs();
			const fetched = await runner.execute({
				code: 'use agent_lib::prelude::*; fn main() -> Result<()> { rlm::deps::add("hex")?; Ok(()) }',
			});
			expect(fetched.status, fetched.compileDiagnostics ?? fetched.stderr).toBe("ok");
			expect(readCellDependencies(workspace)).toEqual([...TEMPLATE_CRATES, "hex"].sort());
			expect(existsSync(join(workspace, "vendor/hex/Cargo.toml"))).toBe(true);
			vi.stubEnv("CARGO_HOME", cargoHome);
			vi.stubEnv("CARGO_NET_OFFLINE", "true");
			const code = `use agent_lib::prelude::*;
            use extra::base64::Engine;
            fn main() -> Result<()> {
                assert_eq!(extra::itoa::Buffer::new().format(42), "42");
                assert_eq!(extra::base64::engine::general_purpose::STANDARD.encode(b"ok"), "b2s=");
                assert_eq!(extra::memchr::memchr(b'x', b"axb"), Some(1));
                assert!(extra::aho_corasick::AhoCorasick::new(["hello"])?.is_match("hello"));
                assert!(extra::regex_automata::meta::Regex::new("[0-9]+")?.is_match("42"));
                assert!(extra::regex_syntax::Parser::new().parse("[0-9]+").is_ok());
                assert_eq!(extra::hex::encode(b"ok"), "6f6b");
                println!("all seven"); Ok(())
            }`;
			const used = await runner.execute({ code });
			expect(used.status, used.compileDiagnostics ?? used.stderr).toBe("ok");
			expect(used.stdout.trim()).toBe("all seven");
			await first.dispose();
			const marker = readFileSync(join(workspace, ".workspace-version"), "utf-8");
			const resumed = await provision({ cwd: root, workspaceDir: workspace }).ensure();
			expect(readFileSync(join(workspace, ".workspace-version"), "utf-8")).toBe(marker);
			expect((await resumed.execute({ code })).stdout.trim()).toBe("all seven");
			const seed = join(root, "seed");
			snapshotWorkspace(workspace, seed);
			const childWorkspace = join(root, "child");
			const child = await provision({ cwd: root, workspaceDir: childWorkspace, initialWorkspaceDir: seed }).ensure();
			const inherited = await child.execute({ code });
			expect(inherited.status, inherited.compileDiagnostics ?? inherited.stderr).toBe("ok");
			expect(inherited.stdout.trim()).toBe("all seven");
			expect(existsSync(join(childWorkspace, "state/open.txt"))).toBe(false);
			expect(readFileSync(join(resolveTemplateDir(), "Cargo.toml"), "utf-8")).toBe(templateManifest);
		},
	);
	it(
		"retains dependency files on failed or cancelled builds and serializes concurrent additions",
		{ timeout: 180_000 },
		async () => {
			const { root, workspace } = fixture();
			const provisioner = provision({ cwd: root, workspaceDir: workspace });
			await provisioner.ensure();
			const handler = createDependencyHandler({
				workspace,
				template: resolveTemplateDir(),
				cargoBin: provisioner.toolchain!.cargoBin,
				configured: [],
				timeoutMs: 120_000,
			});
			const context = { signal: new AbortController().signal };
			const before = new Map(
				DEPENDENCY_PATHS.filter((path) => path !== "vendor" && existsSync(join(workspace, path))).map((path) => [
					path,
					readFileSync(join(workspace, path), "utf-8"),
				]),
			);
			// Model library edits are retained by the host; preflight must reject a broken library.
			const library = join(workspace, "agent_lib/src/lib.rs");
			const source = readFileSync(library, "utf-8");
			writeFileSync(library, `${source}\ncompile_error!("preflight failure");\n`);
			await expect(handler({ crate_name: "itoa" }, context)).rejects.toThrow("Dependency build failed");
			writeFileSync(library, source);
			for (const [path, content] of before) expect(readFileSync(join(workspace, path), "utf-8")).toBe(content);
			expect(readCellDependencies(workspace)).toEqual([]);
			const controller = new AbortController();
			const cancelled = handler({ crate_name: "itoa" }, { signal: controller.signal });
			setTimeout(() => controller.abort(), 0);
			await expect(cancelled).rejects.toThrow();
			for (const [path, content] of before) expect(readFileSync(join(workspace, path), "utf-8")).toBe(content);
			await Promise.all([handler({ crate_name: "itoa" }, context), handler({ crate_name: "base64" }, context)]);
			expect(readCellDependencies(workspace)).toEqual(["base64", "itoa"]);
			const history = new WorkspaceHistory(workspace);
			const snapshot = vi.spyOn(history, "snapshotDependency").mockImplementation(() => {
				throw new Error("Git unavailable");
			});
			const withHistory = createDependencyHandler({
				workspace,
				template: resolveTemplateDir(),
				cargoBin: provisioner.toolchain!.cargoBin,
				configured: [],
				timeoutMs: 120_000,
				history,
			});
			await expect(withHistory({ crate_name: "memchr" }, context)).rejects.toThrow(
				"was added, but its Git snapshot failed",
			);
			expect(readCellDependencies(workspace)).toEqual(["base64", "itoa", "memchr"]);
			await expect(withHistory({ crate_name: "memchr" }, context)).resolves.toEqual({ already_available: true });
			expect(snapshot).toHaveBeenCalledTimes(1);
		},
	);
	it("rejects a curated name already used by a mounted skill", { timeout: 120_000 }, async () => {
		const { root, workspace } = fixture();
		const skill = join(root, "skill");
		mkdirSync(join(skill, "src"), { recursive: true });
		writeFileSync(join(skill, "Cargo.toml"), '[package]\nname = "itoa"\nversion = "0.1.0"\nedition = "2021"\n');
		writeFileSync(join(skill, "src/lib.rs"), "pub fn value() -> u32 { 7 }\n");
		const runner = await provision({
			cwd: root,
			workspaceDir: workspace,
			rustSkills: [{ name: "itoa", crateName: "itoa", cratePath: skill, cargoTomlPath: join(skill, "Cargo.toml") }],
		}).ensure();
		const result = await runner.execute({
			code: `use agent_lib::prelude::*;
            fn main() -> Result<()> {
                assert_eq!(agent_lib::skills::itoa::value(), 7);
                assert!(rlm::deps::add("itoa").unwrap_err().to_string().contains("conflicts with a mounted skill"));
                Ok(())
            }`,
		});
		expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
		expect(readCellDependencies(workspace)).toEqual([]);
	});
});
