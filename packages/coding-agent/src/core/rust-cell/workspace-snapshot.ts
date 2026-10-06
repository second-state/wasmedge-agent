import {
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { mountedSkillCrates, type RustSkillMount } from "./workspace.js";

export const WORKSPACE_SEED_DIR = ".rust-workspace-seed";
const INHERITED_MARKER = ".inherited-workspace";
const SNAPSHOT_PATHS = [
	".workspace-version",
	".cell-dependencies.json",
	".cargo",
	"Cargo.toml",
	"Cargo.lock",
	"agent_lib",
	"cell/Cargo.toml",
	"rlm",
	"skills",
	"target",
	"vendor",
];

/** Capture before spawn admission, while the parent cell still owns its
 * workspace. Skills are materialized so child edits cannot reach the parent.
 * Test/dependency workspaces can omit unmounted sources retained for repair. */
export function snapshotWorkspace(
	source: string,
	destination: string,
	options?: { mountedSkillsOnly?: boolean },
): void {
	mkdirSync(dirname(destination), { recursive: true });
	const staging = mkdtempSync(join(dirname(destination), ".workspace-snapshot-"));
	try {
		const paths = SNAPSHOT_PATHS.flatMap((path) =>
			path === "skills" && options?.mountedSkillsOnly
				? mountedSkillCrates(source).map((crate) => `skills/${crate}`)
				: [path],
		);
		for (const path of paths) {
			if (!lstatSync(join(source, path), { throwIfNoEntry: false })) continue;
			cpSync(join(source, path), join(staging, path), {
				recursive: true,
				dereference: true,
				preserveTimestamps: true,
				mode: constants.COPYFILE_FICLONE,
				filter: (entry) => !entry.split(/[\\/]/).includes(".git"),
			});
		}
		mkdirSync(join(staging, "cell", "src"), { recursive: true });
		writeFileSync(join(staging, "cell", "src", "main.rs"), "fn main() {}\n");
		writeFileSync(join(staging, INHERITED_MARKER), "1\n");
		renameSync(staging, destination);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/** Keep inherited skill copies on reload instead of relinking shared sources. */
export function withInheritedSkills(workspace: string, discovered: RustSkillMount[]): RustSkillMount[] {
	const skillsDir = join(workspace, "skills");
	if (!existsSync(join(workspace, INHERITED_MARKER)) || !existsSync(skillsDir)) return discovered;
	const inherited = readdirSync(skillsDir).flatMap((crateName): RustSkillMount[] => {
		const cratePath = join(skillsDir, crateName);
		const cargoTomlPath = join(cratePath, "Cargo.toml");
		if (!lstatSync(cratePath).isDirectory()) return [];
		// Probe missing manifests as local failures; falling back to a discovered
		// source would replace this directory with a symlink and discard child edits.
		return [
			{
				name: discovered.find((skill) => skill.crateName === crateName)?.name ?? crateName,
				crateName,
				cratePath,
				cargoTomlPath,
			},
		];
	});
	const names = new Set(inherited.map((skill) => skill.crateName));
	return [...inherited, ...discovered.filter((skill) => !names.has(skill.crateName))];
}
