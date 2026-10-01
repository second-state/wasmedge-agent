import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustCellProvisioner, type RustCellProvisionerOptions } from "../src/core/rust-cell/index.js";
import { isTemplateWarm, resolveToolchain } from "../src/core/rust-cell/toolchain.js";
import { resolveTemplateDir } from "../src/core/rust-cell/workspace.js";
import { snapshotWorkspace } from "../src/core/rust-cell/workspace-snapshot.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("configured crates with real Cargo and WasmEdge", () => {
	const dirs: string[] = [];
	const provisioners: RustCellProvisioner[] = [];
	afterEach(async () => {
		for (const provisioner of provisioners.splice(0)) await provisioner.dispose();
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function provision(options: RustCellProvisionerOptions) {
		const provisioner = new RustCellProvisioner(options);
		provisioners.push(provisioner);
		return provisioner;
	}

	it(
		"adds, resumes, inherits, rolls back failed changes and removes crates without changing the template",
		{ timeout: 300_000 },
		async () => {
			// itoa is already downloaded by template vendoring. No registry access is needed.
			vi.stubEnv("CARGO_NET_OFFLINE", "true");
			const root = mkdtempSync(join(tmpdir(), "prelude-extra-real-"));
			dirs.push(root);
			const workspace = join(root, "workspace");
			const template = resolveTemplateDir();
			const templateManifest = readFileSync(join(template, "Cargo.toml"), "utf-8");
			const options = {
				cwd: root,
				workspaceDir: workspace,
				preludeExtra: [{ name: "itoa", version: "1.0.18", defaultFeatures: false }],
			};
			await provision({ ...options, preludeExtra: [] }).ensure();
			// Older user-edited roots/preludes predate the generated extra module.
			const library = join(workspace, "agent_lib/src/lib.rs");
			writeFileSync(
				library,
				`${readFileSync(library, "utf-8").replace("pub mod prelude_extra;", "")}\npub fn retained() -> u32 { 7 }\n`,
			);
			const prelude = join(workspace, "agent_lib/src/prelude.rs");
			writeFileSync(
				prelude,
				`${readFileSync(prelude, "utf-8").replace("pub use crate::prelude_extra as extra;", "")}\npub fn retained() -> u32 { 8 }\n`,
			);
			const first = provision(options);
			const runner = await first.ensure();
			const code =
				'use agent_lib::prelude::*; fn main() -> Result<()> { assert_eq!(agent_lib::retained(), 7); assert_eq!(retained(), 8); println!("{}", extra::itoa::Buffer::new().format(42)); rlm::state::set("keep", &7)?; Ok(()) }';
			const result = await runner.execute({ code });
			expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
			expect(result.stdout.trim()).toBe("42");
			expect(
				execFileSync("git", ["-C", workspace, "show", "HEAD:agent_lib/src/prelude_extra.rs"], {
					encoding: "utf-8",
				}),
			).toContain("pub use ::itoa;");
			const marker = readFileSync(join(workspace, ".workspace-version"), "utf-8");
			const lock = readFileSync(join(workspace, "Cargo.lock"), "utf-8");
			await first.dispose();
			// A toolchain upgrade must retain the configured dependency lock.
			writeFileSync(
				join(workspace, ".workspace-version"),
				JSON.stringify({ ...JSON.parse(marker), rustcVersion: "older compiler" }),
			);
			await provision(options).ensure();
			expect(readFileSync(join(workspace, "Cargo.lock"), "utf-8")).toBe(lock);
			expect(readFileSync(join(workspace, ".workspace-version"), "utf-8")).toBe(marker);

			// A matching workspace and an inherited seed must not fetch or re-vendor.
			const cargoHome = join(root, "empty-cargo-home");
			mkdirSync(cargoHome);
			vi.stubEnv("CARGO_HOME", cargoHome);
			const resumed = await provision(options).ensure();
			expect(readFileSync(join(workspace, ".workspace-version"), "utf-8")).toBe(marker);
			expect((await resumed.execute({ code })).status).toBe("ok");
			const seed = join(root, "seed");
			snapshotWorkspace(workspace, seed);
			const child = await provision({
				...options,
				workspaceDir: join(root, "child"),
				initialWorkspaceDir: seed,
			}).ensure();
			expect((await child.execute({ code })).stdout.trim()).toBe("42");
			vi.unstubAllEnvs();
			vi.stubEnv("CARGO_NET_OFFLINE", "true");

			const removal = provision({ ...options, preludeExtra: [] });
			await expect(removal.ensure()).rejects.toThrow("original workspace retained");
			expect(readFileSync(join(workspace, ".workspace-version"), "utf-8")).toBe(marker);
			expect(readFileSync(join(workspace, "Cargo.lock"), "utf-8")).toBe(lock);
			expect(readFileSync(join(workspace, "cell/src/main.rs"), "utf-8")).toBe(code);
			expect(readFileSync(join(workspace, "state/state.json"), "utf-8")).toContain("7");

			const invalid = provision({
				...options,
				preludeExtra: [{ name: "itoa", version: "1.0.18", features: ["does-not-exist"] }],
			});
			await expect(invalid.ensure()).rejects.toThrow("original workspace retained");
			expect(readFileSync(join(workspace, ".workspace-version"), "utf-8")).toBe(marker);
			expect(existsSync(join(root, ".workspace.upgrade"))).toBe(false);
			expect((await resumed.execute({ code: "fn main() {}" })).status).toBe("ok");
			await removal.ensure();
			expect(readFileSync(join(workspace, "agent_lib/Cargo.toml"), "utf-8")).not.toContain("itoa");
			expect(readFileSync(join(workspace, "agent_lib/src/prelude_extra.rs"), "utf-8")).not.toContain("pub use");
			expect(readFileSync(join(template, "Cargo.toml"), "utf-8")).toBe(templateManifest);
		},
	);

	it("rejects collisions with discovered skill crates", { timeout: 180_000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "prelude-extra-collision-"));
		dirs.push(root);
		const cratePath = join(root, "itoa");
		mkdirSync(join(cratePath, "src"), { recursive: true });
		const cargoTomlPath = join(cratePath, "Cargo.toml");
		writeFileSync(cargoTomlPath, '[package]\nname="itoa"\nversion="0.1.0"\nedition="2021"\n');
		writeFileSync(join(cratePath, "src/lib.rs"), "pub fn run() {}\n");
		await expect(
			provision({
				cwd: root,
				workspaceDir: join(root, "workspace"),
				preludeExtra: [{ name: "itoa", version: "1.0.18" }],
				rustSkills: [{ name: "itoa", crateName: "itoa", cratePath, cargoTomlPath }],
			}).ensure(),
		).rejects.toThrow("conflicts with a mounted skill");
	});
});
