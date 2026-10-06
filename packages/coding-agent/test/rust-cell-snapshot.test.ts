import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspaceAt, syncRustSkills } from "../src/core/rust-cell/workspace.js";
import { snapshotWorkspace, withInheritedSkills } from "../src/core/rust-cell/workspace-snapshot.js";

describe("child workspace snapshots", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "cell-snapshot-"));
		dirs.push(root);
		const parent = join(root, "parent");
		const seed = join(root, "seed");
		const write = (path: string, text: string) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		};
		write(join(parent, "Cargo.toml"), '[workspace]\nmembers = ["agent_lib", "cell", "rlm"]\n');
		write(join(parent, "agent_lib/Cargo.toml"), '[package]\nname = "agent_lib"\n[dependencies]\n');
		write(join(parent, "agent_lib/src/helpers/tool.rs"), "parent helper");
		write(join(parent, "cell/src/main.rs"), "parent spawning cell");
		const cratePath = join(root, "skill");
		const cargoTomlPath = join(cratePath, "Cargo.toml");
		write(cargoTomlPath, '[package]\nname = "tool"\n');
		write(join(cratePath, "src/lib.rs"), "parent skill");
		const skill = { name: "tool", crateName: "tool", cratePath, cargoTomlPath };
		syncRustSkills(parent, [skill]);
		return { root, parent, seed, write, skill };
	}

	it("freezes helpers and skill sources without state or history, preserving caches", () => {
		const { root, parent, seed, write, skill } = fixture();
		for (const path of ["state/state.json", ".scratch/file", ".git/config", "harness/state.json"])
			write(join(parent, path), "private");
		write(join(skill.cratePath, ".git/config"), "private skill repo");
		write(join(parent, "target/release/cached"), "cache");
		write(join(parent, "vendor/dependency/lib.rs"), "vendored");
		write(join(parent, ".workspace-version"), "parent template version");
		snapshotWorkspace(parent, seed);
		write(join(parent, "agent_lib/src/helpers/tool.rs"), "later parent helper");
		write(join(skill.cratePath, "src/lib.rs"), "later parent skill");
		const child = ensureWorkspaceAt(join(root, "child"), seed);
		expect(readFileSync(join(child, "agent_lib/src/helpers/tool.rs"), "utf-8")).toBe("parent helper");
		expect(readFileSync(join(child, "skills/tool/src/lib.rs"), "utf-8")).toBe("parent skill");
		expect(lstatSync(join(child, "skills/tool")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(child, "cell/src/main.rs"), "utf-8")).toBe("fn main() {}\n");
		for (const path of ["state", ".scratch", ".git", "harness", "skills/tool/.git"])
			expect(existsSync(join(child, path))).toBe(false);
		expect(readFileSync(join(child, "target/release/cached"), "utf-8")).toBe("cache");
		expect(readFileSync(join(child, "vendor/dependency/lib.rs"), "utf-8")).toBe("vendored");
		expect(readFileSync(join(child, ".workspace-version"), "utf-8")).toBe("parent template version");
		const mounts = withInheritedSkills(child, [skill]);
		expect(mounts[0].cratePath).toBe(join(child, "skills/tool"));
		syncRustSkills(child, mounts);
		write(join(child, "skills/tool/src/lib.rs"), "child edit");
		write(join(child, "agent_lib/src/helpers/tool.rs"), "child helper");
		ensureWorkspaceAt(child, seed);
		syncRustSkills(child, withInheritedSkills(child, [skill]));
		expect(readFileSync(join(child, "skills/tool/src/lib.rs"), "utf-8")).toBe("child edit");
		expect(readFileSync(join(child, "agent_lib/src/helpers/tool.rs"), "utf-8")).toBe("child helper");
		expect(readFileSync(join(skill.cratePath, "src/lib.rs"), "utf-8")).toBe("later parent skill");
		expect(readFileSync(join(seed, "skills/tool/src/lib.rs"), "utf-8")).toBe("parent skill");
	});

	it("removes an incomplete snapshot if a skill cannot be copied", () => {
		const { root, parent, seed } = fixture();
		symlinkSync(join(root, "missing"), join(parent, "skills/broken"));
		expect(() => snapshotWorkspace(parent, seed)).toThrow();
		expect(existsSync(seed)).toBe(false);
		expect(readdirSync(root).filter((name) => name.startsWith(".workspace-snapshot-"))).toEqual([]);
	});

	it.each([false, true])("omits crate build output but preserves cache and fixtures (selected: %s)", (selected) => {
		const { root, parent, seed, write, skill } = fixture();
		const crates = ["agent_lib", "rlm", "skills/tool"];
		for (const crate of crates) {
			write(join(parent, crate, "target/debug/output"), "unused build output");
			symlinkSync(join(root, "missing"), join(parent, crate, "target/dangling"));
			symlinkSync(join(parent, crate, "target"), join(parent, crate, "target/cycle"));
			write(join(parent, crate, "fixtures/target/input"), "test input");
		}
		write(join(parent, "target/release/cached"), "workspace cache");
		write(join(parent, "vendor/dependency/target/input"), "vendored input");
		snapshotWorkspace(parent, seed, { mountedSkillsOnly: selected });
		for (const crate of crates) {
			expect(existsSync(join(seed, crate, "target"))).toBe(false);
			expect(readFileSync(join(seed, crate, "fixtures/target/input"), "utf8")).toBe("test input");
			expect(readFileSync(join(parent, crate, "target/debug/output"), "utf8")).toBe("unused build output");
			for (const link of ["dangling", "cycle"])
				expect(lstatSync(join(parent, crate, "target", link)).isSymbolicLink()).toBe(true);
		}
		expect(readFileSync(join(seed, "target/release/cached"), "utf8")).toBe("workspace cache");
		expect(readFileSync(join(seed, "vendor/dependency/target/input"), "utf8")).toBe("vendored input");
		expect(readFileSync(join(skill.cratePath, "src/lib.rs"), "utf8")).toBe("parent skill");
	});

	it.each(["dangling", "cycle"])("does not dereference a %s crate target link", (kind) => {
		const { root, parent, seed, skill } = fixture();
		const target = join(skill.cratePath, "target");
		symlinkSync(kind === "cycle" ? skill.cratePath : join(root, "missing"), target);
		snapshotWorkspace(parent, seed);
		expect(existsSync(join(seed, "skills/tool/target"))).toBe(false);
		expect(readFileSync(join(seed, "skills/tool/src/lib.rs"), "utf8")).toBe("parent skill");
		expect(lstatSync(target).isSymbolicLink()).toBe(true);
	});

	it.each(["dangling", "cycle"])("excludes %s unmounted sources from selected snapshots", (kind) => {
		const { root, parent, seed, write } = fixture();
		const unmounted = join(parent, "skills/unmounted");
		write(join(unmounted, "notes"), "unfinished child work");
		const link = join(unmounted, "fixture");
		symlinkSync(kind === "cycle" ? unmounted : join(root, "missing"), link);
		snapshotWorkspace(parent, seed, { mountedSkillsOnly: true });
		expect(readFileSync(join(seed, "skills/tool/src/lib.rs"), "utf8")).toBe("parent skill");
		expect(lstatSync(join(seed, "skills/tool")).isDirectory()).toBe(true);
		expect(existsSync(join(seed, "skills/unmounted"))).toBe(false);
		expect(readFileSync(join(unmounted, "notes"), "utf8")).toBe("unfinished child work");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
	});

	it("retains unmounted child sources in full snapshots", () => {
		const { parent, seed, write } = fixture();
		write(join(parent, "skills/unmounted/notes"), "unfinished child work");
		snapshotWorkspace(parent, seed);
		expect(readFileSync(join(seed, "skills/unmounted/notes"), "utf8")).toBe("unfinished child work");
	});

	it("rejects unreadable mounted sources in selected snapshots", () => {
		const { root, parent, seed, skill } = fixture();
		symlinkSync(join(root, "missing"), join(skill.cratePath, "fixture"));
		expect(() => snapshotWorkspace(parent, seed, { mountedSkillsOnly: true })).toThrow(/ENOENT/);
		expect(existsSync(seed)).toBe(false);
		expect(readdirSync(root).filter((name) => name.startsWith(".workspace-snapshot-"))).toEqual([]);
	});

	it("does not replace a child skill with the shared source when its manifest is missing", () => {
		const { root, parent, seed, write, skill } = fixture();
		snapshotWorkspace(parent, seed);
		const child = ensureWorkspaceAt(join(root, "child"), seed);
		const childSkill = join(child, "skills/tool");
		write(join(childSkill, "src/lib.rs"), "child edit");
		write(join(childSkill, "notes.txt"), "unfinished child work");
		rmSync(join(childSkill, "Cargo.toml"));
		syncRustSkills(child, withInheritedSkills(child, [skill]));
		expect(lstatSync(childSkill).isDirectory()).toBe(true);
		expect(readFileSync(join(childSkill, "src/lib.rs"), "utf-8")).toBe("child edit");
		expect(readFileSync(join(childSkill, "notes.txt"), "utf-8")).toBe("unfinished child work");
		expect(existsSync(join(childSkill, "Cargo.toml"))).toBe(false);
		expect(readFileSync(join(skill.cratePath, "src/lib.rs"), "utf-8")).toBe("parent skill");
		expect(readFileSync(join(seed, "skills/tool/src/lib.rs"), "utf-8")).toBe("parent skill");
	});
});
