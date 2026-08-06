/** syncRustSkills workspace mounting (DESIGN.md §4.1). The unit block edits a
 * fake template-shaped workspace with no cargo; the gated integration block
 * mounts real crates and proves cells call them (and that one broken skill
 * cannot brick the workspace). */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo } from "../src/core/rust-cell/toolchain.js";
import { ensureWorkspaceAt, type RustSkillMount, syncRustSkills } from "../src/core/rust-cell/workspace.js";

function writeFakeWorkspace(root: string): string {
	const workspace = join(root, "workspace");
	mkdirSync(join(workspace, "agent_lib", "src", "skills"), { recursive: true });
	writeFileSync(
		join(workspace, "Cargo.toml"),
		'[workspace]\nmembers = ["agent_lib", "cell", "rlm"]\nresolver = "2"\n',
	);
	writeFileSync(
		join(workspace, "agent_lib", "Cargo.toml"),
		'[package]\nname = "agent_lib"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nanyhow = "1"\n',
	);
	writeFileSync(join(workspace, "agent_lib", "src", "skills", "mod.rs"), "//! empty\n");
	return workspace;
}

function writeSkillCrate(root: string, name: string, libSource: string): RustSkillMount {
	const crateName = name.replaceAll("-", "_");
	const cratePath = join(root, name);
	mkdirSync(join(cratePath, "src"), { recursive: true });
	const cargoTomlPath = join(cratePath, "Cargo.toml");
	writeFileSync(cargoTomlPath, `[package]\nname = "${crateName}"\nversion = "0.1.0"\nedition = "2021"\n`);
	writeFileSync(join(cratePath, "src", "lib.rs"), libSource);
	return { name, crateName, cratePath, cargoTomlPath };
}

describe("syncRustSkills (unit)", () => {
	const tempDirs: string[] = [];
	afterAll(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	});

	it("mounts skills into members, agent_lib deps, and the skills re-export", () => {
		const root = mkdtempSync(join(tmpdir(), "skills-unit-"));
		tempDirs.push(root);
		const workspace = writeFakeWorkspace(root);
		const skill = writeSkillCrate(root, "word-count", "pub fn run() {}\n");

		const result = syncRustSkills(workspace, [skill]);
		expect(result.changed).toBe(true);
		expect(result.mounted).toEqual(["word_count"]);
		expect(result.failed).toEqual([]);

		const rootManifest = readFileSync(join(workspace, "Cargo.toml"), "utf-8");
		expect(rootManifest).toContain('"agent_lib", "cell", "rlm", "skills/word_count"');
		const libManifest = readFileSync(join(workspace, "agent_lib", "Cargo.toml"), "utf-8");
		expect(libManifest).toContain('word_count = { path = "../skills/word_count" }');
		expect(libManifest).toContain("managed by wasmedge-agent");
		expect(readlinkSync(join(workspace, "skills", "word_count"))).toBe(skill.cratePath);
		const modRs = readFileSync(join(workspace, "agent_lib", "src", "skills", "mod.rs"), "utf-8");
		expect(modRs).toContain("pub use word_count;");
	});

	it("is idempotent while the skill set is unchanged and regenerates on removal", () => {
		const root = mkdtempSync(join(tmpdir(), "skills-unit-"));
		tempDirs.push(root);
		const workspace = writeFakeWorkspace(root);
		const skill = writeSkillCrate(root, "alpha", "pub fn run() {}\n");

		expect(syncRustSkills(workspace, [skill]).changed).toBe(true);
		expect(syncRustSkills(workspace, [skill]).changed).toBe(false);

		// Manifest edits re-trigger a sync…
		writeFileSync(skill.cargoTomlPath, `${readFileSync(skill.cargoTomlPath, "utf-8")}\n# touched\n`);
		expect(syncRustSkills(workspace, [skill]).changed).toBe(true);

		// …and removing the skill regenerates every managed surface without it.
		const removed = syncRustSkills(workspace, []);
		expect(removed.changed).toBe(true);
		expect(removed.mounted).toEqual([]);
		expect(readFileSync(join(workspace, "Cargo.toml"), "utf-8")).toContain('members = ["agent_lib", "cell", "rlm"]');
		expect(readFileSync(join(workspace, "agent_lib", "Cargo.toml"), "utf-8")).not.toContain("alpha");
		expect(readFileSync(join(workspace, "agent_lib", "src", "skills", "mod.rs"), "utf-8")).not.toContain("alpha");
		expect(existsSync(join(workspace, "skills", "alpha"))).toBe(false);
	});
});

let toolchain: ToolchainInfo | undefined;
try {
	toolchain = resolveToolchain();
} catch {
	toolchain = undefined;
}
const available = toolchain !== undefined && isTemplateWarm();

describe.skipIf(!available)("syncRustSkills (toolchain integration)", () => {
	const tempDirs: string[] = [];
	afterAll(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	});

	it("mounts a healthy skill, unmounts a broken one, and cells call the survivor", { timeout: 300_000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "skills-int-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const workspace = ensureWorkspaceAt(join(root, "workspace"));

		const healthy = writeSkillCrate(
			root,
			"greeter",
			'pub fn greet(name: &str) -> String {\n    format!("hello {name}")\n}\n',
		);
		const broken = writeSkillCrate(root, "broken-skill", "pub fn nope() -> { this is not rust }\n");

		const sync = syncRustSkills(workspace, [healthy, broken], { cargoBin: toolchain?.cargoBin });
		expect(sync.mounted).toEqual(["greeter"]);
		expect(sync.failed.map((f) => f.name)).toEqual(["broken-skill"]);

		const runner = new CellRunner({
			cwd,
			workspaceDir: workspace,
			wasmedgeBin: toolchain?.wasmedgeBin as string,
			cargoBin: toolchain?.cargoBin as string,
			cellTimeoutMs: 240_000,
		});
		const result = await runner.execute({
			code: 'fn main() {\n    println!("{}", agent_lib::skills::greeter::greet("workspace"));\n}\n',
		});
		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("hello workspace");
	});
});
