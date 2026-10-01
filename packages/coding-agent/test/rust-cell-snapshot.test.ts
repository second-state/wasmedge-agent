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
});
