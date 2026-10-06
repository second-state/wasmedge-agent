/** syncRustSkills workspace mounting (DESIGN.md §4.1). The unit block edits a
 * fake template-shaped workspace with no cargo; the gated integration block
 * mounts real crates and proves cells call them (and that one broken skill
 * cannot brick the workspace). */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo } from "../src/core/rust-cell/toolchain.js";
import {
	ensureWorkspaceAt,
	mountedSkillCrates,
	type RustSkillMount,
	syncRustSkills,
} from "../src/core/rust-cell/workspace.js";
import { snapshotWorkspace, withInheritedSkills } from "../src/core/rust-cell/workspace-snapshot.js";

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
		expect(mountedSkillCrates(workspace)).toEqual(["word_count"]);

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

	it("detects source, test, fixture and symlink target edits while ignoring build output", () => {
		const root = mkdtempSync(join(tmpdir(), "skills-unit-"));
		tempDirs.push(root);
		const workspace = writeFakeWorkspace(root);
		const skill = writeSkillCrate(root, "alpha", "pub fn run() {}\n");
		syncRustSkills(workspace, [skill]);
		for (const path of ["src/lib.rs", "src/nested/module.rs", "tests/check.rs", "fixtures/input.json"]) {
			const file = join(skill.cratePath, path);
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, "changed");
			expect(syncRustSkills(workspace, [skill]).changed, path).toBe(true);
			expect(syncRustSkills(workspace, [skill]).changed).toBe(false);
			rmSync(file);
			expect(syncRustSkills(workspace, [skill]).changed).toBe(true);
		}
		const target = join(root, "shared.rs");
		writeFileSync(target, "first");
		symlinkSync(target, join(skill.cratePath, "src/shared.rs"));
		syncRustSkills(workspace, [skill]);
		writeFileSync(target, "second");
		expect(syncRustSkills(workspace, [skill]).changed).toBe(true);
		for (const ignored of ["target", ".git"]) {
			mkdirSync(join(skill.cratePath, ignored));
			writeFileSync(join(skill.cratePath, ignored, "output"), "ignored");
		}
		expect(syncRustSkills(workspace, [skill]).changed).toBe(false);
		symlinkSync(skill.cratePath, join(skill.cratePath, "src/cycle"));
		expect(() => syncRustSkills(workspace, [skill])).toThrow("symlink cycle");
	});

	it("repairs changed mount links and configuration even when skill sources are unchanged", () => {
		const root = mkdtempSync(join(tmpdir(), "skills-mount-repair-"));
		tempDirs.push(root);
		const workspace = writeFakeWorkspace(root);
		const skill = writeSkillCrate(root, "alpha", "pub fn run() {}\n");
		const other = writeSkillCrate(root, "other", "pub fn other() {}\n");
		syncRustSkills(workspace, [skill]);
		const link = join(workspace, "skills/alpha");
		const files = ["Cargo.toml", "agent_lib/Cargo.toml", "agent_lib/src/skills/mod.rs"];
		const expected = files.map((path) => readFileSync(join(workspace, path), "utf-8"));
		const mutations = [
			() => rmSync(link),
			() => {
				rmSync(link);
				symlinkSync(other.cratePath, link);
			},
			() => writeFileSync(join(workspace, files[0]), expected[0].replace("skills/alpha", "skills/missing")),
			() => writeFileSync(join(workspace, files[1]), expected[1].replace("../skills/alpha", "../skills/missing")),
			() => writeFileSync(join(workspace, files[2]), "pub use missing;\n"),
			() => rmSync(join(workspace, files[2])),
		];
		for (const mutate of mutations) {
			mutate();
			expect(syncRustSkills(workspace, [skill])).toMatchObject({ changed: true, mounted: ["alpha"], failed: [] });
			expect(readlinkSync(link)).toBe(skill.cratePath);
			expect(files.map((path) => readFileSync(join(workspace, path), "utf-8"))).toEqual(expected);
			expect(syncRustSkills(workspace, [skill]).changed).toBe(false);
		}
	});

	it("retains inherited skill sources when unmounted so they can be repaired and remounted", () => {
		const root = mkdtempSync(join(tmpdir(), "skills-retained-"));
		tempDirs.push(root);
		const workspace = writeFakeWorkspace(root);
		const skill = writeSkillCrate(join(workspace, "skills"), "local", "not Rust\n");
		writeFileSync(join(workspace, ".inherited-workspace"), "1\n");
		syncRustSkills(workspace, [skill]);
		expect(syncRustSkills(workspace, []).mounted).toEqual([]);
		expect(mountedSkillCrates(workspace)).toEqual([]);
		expect(readFileSync(join(skill.cratePath, "src/lib.rs"), "utf-8")).toBe("not Rust\n");
		expect(readFileSync(join(workspace, "agent_lib/src/skills/mod.rs"), "utf-8")).not.toContain("pub use local");
		writeFileSync(join(skill.cratePath, "src/lib.rs"), "pub fn repaired() {}\n");
		expect(syncRustSkills(workspace, withInheritedSkills(workspace, [])).mounted).toEqual(["local"]);
		expect(readFileSync(join(skill.cratePath, "src/lib.rs"), "utf-8")).toBe("pub fn repaired() {}\n");
	});

	it("rejects damaged mount declarations instead of treating them as an empty set", () => {
		const root = mkdtempSync(join(tmpdir(), "skills-mount-metadata-"));
		tempDirs.push(root);
		const workspace = writeFakeWorkspace(root);
		expect(mountedSkillCrates(workspace)).toEqual([]);
		syncRustSkills(workspace, [writeSkillCrate(root, "alpha", "pub fn run() {}\n")]);
		const path = join(workspace, "agent_lib/Cargo.toml");
		const manifest = readFileSync(path, "utf-8");
		for (const invalid of [
			manifest.replace("# --- end skills ---", ""),
			manifest.replace("# --- skills (managed by wasmedge-agent; do not edit) ---", ""),
			manifest.replace("../skills/alpha", "../skills/another"),
		]) {
			writeFileSync(path, invalid);
			expect(() => mountedSkillCrates(workspace)).toThrow("Invalid managed skills block");
		}
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

	it("reprobes source-only changes and does not reuse an unprobed mount", { timeout: 300_000 }, () => {
		const root = mkdtempSync(join(tmpdir(), "skills-source-"));
		tempDirs.push(root);
		const workspace = ensureWorkspaceAt(join(root, "workspace"));
		const skill = writeSkillCrate(root, "editable", "pub fn value() -> u32 { 42 }\n");
		const options = { cargoBin: toolchain!.cargoBin };
		expect(syncRustSkills(workspace, [skill], options).mounted).toEqual(["editable"]);
		writeFileSync(join(skill.cratePath, "src/lib.rs"), "not Rust\n");
		const broken = syncRustSkills(workspace, [skill], options);
		expect(broken.mounted).toEqual([]);
		expect(broken.failed.map((failure) => failure.name)).toEqual(["editable"]);
		syncRustSkills(workspace, [skill]);
		expect(syncRustSkills(workspace, [skill], options).mounted).toEqual([]);
		writeFileSync(join(skill.cratePath, "src/lib.rs"), "pub fn value() -> u32 { 43 }\n");
		expect(syncRustSkills(workspace, [skill], options).mounted).toEqual(["editable"]);
		expect(syncRustSkills(workspace, [skill], options).changed).toBe(false);
	});

	it(
		"retains child skill edits through shared source failures and local manifest repair",
		{ timeout: 300_000 },
		async () => {
			const root = mkdtempSync(join(tmpdir(), "skills-child-"));
			tempDirs.push(root);
			const parent = ensureWorkspaceAt(join(root, "parent"));
			const skill = writeSkillCrate(root, "shared", "pub fn value() -> u32 { 42 }\n");
			syncRustSkills(parent, [skill], { cargoBin: toolchain?.cargoBin });
			const seed = join(root, "seed");
			snapshotWorkspace(parent, seed);
			writeFileSync(join(skill.cratePath, "src/lib.rs"), "not Rust\n");
			const diagnostics: string[] = [];
			const child = new RustCellProvisioner({
				cwd: root,
				workspaceDir: join(root, "child"),
				initialWorkspaceDir: seed,
				rustSkills: [skill],
				onDiagnostic: (message) => diagnostics.push(message),
			});
			try {
				const runner = await child.ensure();
				const result = await runner.execute({
					code: 'fn main() { println!("{}", agent_lib::skills::shared::value()); }',
				});
				expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
				expect(result.stdout.trim()).toBe("42");
				await child.dispose();
				const localSkill = join(root, "child/skills/shared");
				const localManifest = join(localSkill, "Cargo.toml");
				const manifest = readFileSync(localManifest, "utf-8");
				writeFileSync(join(localSkill, "src/lib.rs"), "pub fn value() -> u32 { 77 }\n");
				rmSync(localManifest);
				writeFileSync(join(skill.cratePath, "src/lib.rs"), "pub fn value() -> u32 { 99 }\n");
				const unused = writeSkillCrate(join(root, "child/skills"), "unused", "not Rust\n");
				const reloaded = await child.ensure();
				expect(lstatSync(localSkill).isDirectory()).toBe(true);
				expect(readFileSync(join(localSkill, "src/lib.rs"), "utf-8")).toContain("77");
				expect(existsSync(localManifest)).toBe(false);
				expect(diagnostics).toContainEqual(
					expect.stringContaining('rust skill "shared" failed to compile and was unmounted'),
				);
				const independent = await reloaded.execute({
					code: 'use agent_lib::prelude::*; fn main() -> Result<()> { rlm::deps::add("itoa")?; println!("independent"); Ok(()) }',
				});
				expect(independent.status, independent.compileDiagnostics ?? independent.stderr).toBe("ok");
				expect(independent.stdout.trim()).toBe("independent");
				expect(readFileSync(join(unused.cratePath, "src/lib.rs"), "utf-8")).toBe("not Rust\n");
				await child.dispose();
				writeFileSync(localManifest, manifest);
				const repaired = await (await child.ensure()).execute({
					code: 'fn main() { println!("{}", agent_lib::skills::shared::value()); }',
				});
				expect(repaired.status, repaired.compileDiagnostics ?? repaired.stderr).toBe("ok");
				expect(repaired.stdout.trim()).toBe("77");
				expect(readFileSync(join(skill.cratePath, "src/lib.rs"), "utf-8")).toContain("99");
				expect(readFileSync(join(seed, "skills/shared/src/lib.rs"), "utf-8")).toContain("42");
			} finally {
				await child.dispose();
			}
		},
	);

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

		rmSync(join(workspace, "skills/greeter"));
		rmSync(join(workspace, "agent_lib/src/skills/mod.rs"));
		const repaired = syncRustSkills(workspace, [healthy], { cargoBin: toolchain?.cargoBin });
		expect(repaired).toMatchObject({ changed: true, mounted: ["greeter"], failed: [] });
		expect(syncRustSkills(workspace, [healthy], { cargoBin: toolchain?.cargoBin }).changed).toBe(false);

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

	it(
		"isolates manifest and dependency failures without breaking healthy path dependencies",
		{ timeout: 300_000 },
		async () => {
			const root = mkdtempSync(join(tmpdir(), "skills-manifest-"));
			tempDirs.push(root);
			const workspace = ensureWorkspaceAt(join(root, "workspace"));
			const helper = writeSkillCrate(root, "healthy_helper", "pub fn value() -> u32 { 21 }\n");
			const healthy = writeSkillCrate(
				root,
				"healthy_consumer",
				"pub fn value() -> u32 { healthy_helper::value() * 2 }\n",
			);
			writeFileSync(
				healthy.cargoTomlPath,
				`${readFileSync(healthy.cargoTomlPath, "utf-8")}\n[dependencies]\nhealthy_helper = { path = "../healthy_helper" }\n`,
			);
			const broken = writeSkillCrate(root, "broken", "pub fn value() -> u32 { 7 }\n");
			const dependent = writeSkillCrate(root, "broken_consumer", "pub fn value() -> u32 { broken::value() }\n");
			writeFileSync(
				dependent.cargoTomlPath,
				`${readFileSync(dependent.cargoTomlPath, "utf-8")}\n[dependencies]\nbroken = { path = "../broken" }\n`,
			);
			const validManifest = readFileSync(broken.cargoTomlPath, "utf-8");
			const skills = [healthy, helper, dependent, broken];
			const options = { cargoBin: toolchain!.cargoBin };
			const runner = new CellRunner({
				cwd: root,
				workspaceDir: workspace,
				wasmedgeBin: toolchain!.wasmedgeBin,
				cargoBin: toolchain!.cargoBin,
				cellTimeoutMs: 240_000,
			});

			for (const manifest of [
				"[package\n",
				undefined,
				`${validManifest}\n[dependencies]\nabsent = { path = "../absent" }\n`,
			]) {
				if (manifest === undefined) rmSync(broken.cargoTomlPath);
				else writeFileSync(broken.cargoTomlPath, manifest);
				const sync = syncRustSkills(workspace, skills, options);
				expect(sync.mounted).toEqual(["healthy_consumer", "healthy_helper"]);
				expect(sync.failed.map((failure) => failure.name)).toEqual(["broken_consumer", "broken"]);
				const result = await runner.execute({
					code: 'fn main() { println!("{}", agent_lib::skills::healthy_consumer::value()); }',
				});
				expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
				expect(result.stdout.trim()).toBe("42");
			}

			writeFileSync(broken.cargoTomlPath, validManifest);
			const repaired = syncRustSkills(workspace, skills, options);
			expect(repaired.mounted).toEqual(skills.map((skill) => skill.crateName));
			expect(repaired.failed).toEqual([]);
			expect(syncRustSkills(workspace, skills, options).changed).toBe(false);
			const result = await runner.execute({
				code: 'fn main() { println!("{}", agent_lib::skills::broken_consumer::value()); }',
			});
			expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
			expect(result.stdout.trim()).toBe("7");
		},
	);
});
