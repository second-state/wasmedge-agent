import { execFileSync } from "node:child_process";
import { constants, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import { isTemplateWarm, resolveToolchain } from "../src/core/rust-cell/toolchain.js";
import { resolveTemplateDir } from "../src/core/rust-cell/workspace.js";
import { WORKSPACE_VERSION_FILE } from "../src/core/rust-cell/workspace-version.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("workspace upgrades with real Cargo and WasmEdge", () => {
	const dirs: string[] = [];
	const provisioners: RustCellProvisioner[] = [];
	afterEach(async () => {
		for (const provisioner of provisioners.splice(0)) await provisioner.dispose();
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps intermediate artifacts local despite a global Cargo build directory", () => {
		const cargoHome = mkdtempSync(join(tmpdir(), "workspace-upgrade-cargo-"));
		dirs.push(cargoHome);
		writeFileSync(join(cargoHome, "config.toml"), '[build]\nbuild-dir = "shared"\n');
		const template = resolveTemplateDir();
		const metadata = JSON.parse(
			execFileSync(resolveToolchain().cargoBin, ["metadata", "--offline", "--no-deps", "--format-version", "1"], {
				cwd: template,
				env: { ...process.env, CARGO_HOME: cargoHome },
				encoding: "utf-8",
			}),
		) as { target_directory: string; build_directory?: string };
		expect(resolve(metadata.target_directory)).toBe(resolve(template, "target"));
		// Cargo versions before build-dir support store intermediates in target_directory.
		if (metadata.build_directory) expect(resolve(metadata.build_directory)).toBe(resolve(template, "target"));
	});

	it.each([false, true])(
		"preserves cells, library overrides, skills, state and history (legacy: %s)",
		{ timeout: 300_000 },
		async (legacy) => {
			const root = mkdtempSync(join(tmpdir(), "workspace-upgrade-real-"));
			dirs.push(root);
			const template = join(root, "template");
			cpSync(resolveTemplateDir(), template, {
				recursive: true,
				mode: constants.COPYFILE_FICLONE,
				preserveTimestamps: true,
			});
			vi.stubEnv("WASMEDGE_AGENT_TEMPLATE_DIR", template);
			const workspace = join(root, "workspace");
			const cratePath = join(root, "skill");
			mkdirSync(join(cratePath, "src"), { recursive: true });
			const cargoTomlPath = join(cratePath, "Cargo.toml");
			writeFileSync(cargoTomlPath, '[package]\nname = "shared"\nversion = "0.1.0"\nedition = "2021"\n');
			writeFileSync(join(cratePath, "src/lib.rs"), "pub fn value() -> u32 { 43 }\n");
			const options = {
				cwd: root,
				workspaceDir: workspace,
				rustSkills: [{ name: "shared", crateName: "shared", cratePath, cargoTomlPath }],
			};
			const original = new RustCellProvisioner(options);
			provisioners.push(original);
			const runner = await original.ensure();
			const prelude = `${readFileSync(join(template, "agent_lib/src/prelude.rs"), "utf-8")}\npub fn user_value() -> u32 { 44 }\n`;
			const code =
				'use agent_lib::prelude::*; fn main() -> Result<()> { std::fs::write("/workspace/executed", "once")?; rlm::state::set("counter", &41_u32)?; Ok(()) }';
			const first = await runner.execute({
				code,
				lib: [
					{ path: "src/helpers/keep.rs", content: "pub fn value() -> u32 { 42 }\n" },
					{ path: "src/prelude.rs", content: prelude },
				],
			});
			expect(first.status, first.compileDiagnostics ?? first.stderr).toBe("ok");
			await original.dispose();
			if (legacy) rmSync(join(workspace, WORKSPACE_VERSION_FILE));
			// The retained program would recreate this file if the migration ran it.
			rmSync(join(root, "executed"));
			const markerBefore = legacy ? undefined : readFileSync(join(workspace, WORKSPACE_VERSION_FILE), "utf-8");
			const runtimePath = join(template, "rlm/src/lib.rs");
			const runtimeSource = readFileSync(runtimePath, "utf-8");
			writeFileSync(runtimePath, `${runtimeSource}\nthis will not compile\n`);
			const upgraded = new RustCellProvisioner(options);
			provisioners.push(upgraded);
			await expect(upgraded.ensure()).rejects.toThrow("Workspace upgrade failed; original workspace retained");
			expect(readFileSync(join(workspace, "rlm/src/lib.rs"), "utf-8")).toBe(runtimeSource);
			if (markerBefore) expect(readFileSync(join(workspace, WORKSPACE_VERSION_FILE), "utf-8")).toBe(markerBefore);
			writeFileSync(runtimePath, `${runtimeSource}\npub fn upgrade_probe() -> u32 { 2 }\n`);
			const resumed = await upgraded.ensure();
			expect(readFileSync(join(workspace, "agent_lib/src/prelude.rs"), "utf-8")).toBe(prelude);
			expect(readFileSync(join(workspace, "cell/src/main.rs"), "utf-8")).toBe(code);
			expect(readFileSync(join(workspace, "state/state.json"), "utf-8")).toContain("41");
			expect(execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim()).toBe(
				first.workspaceCommit,
			);
			expect(() => readFileSync(join(root, "executed"))).toThrow();
			const result = await resumed.execute({
				code: `use agent_lib::prelude::*;
fn main() -> Result<()> {
    println!("{} {} {} {} {}", rlm::state::get::<u32>("counter")?.unwrap(), agent_lib::helpers::keep::value(), agent_lib::skills::shared::value(), user_value(), rlm::upgrade_probe());
    Ok(())
}`,
			});
			expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
			expect(result.stdout.trim()).toBe("41 42 43 44 2");
			expect(
				execFileSync("git", ["-C", workspace, "show", `HEAD:${WORKSPACE_VERSION_FILE}`], { encoding: "utf-8" }),
			).toContain('"schema": 1');
		},
	);
});
