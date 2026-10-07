import { constants, existsSync, lstatSync, readdirSync, renameSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
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
export async function snapshotWorkspace(
	source: string,
	destination: string,
	options?: { mountedSkillsOnly?: boolean; signal?: AbortSignal },
): Promise<void> {
	const check = () => options?.signal?.throwIfAborted();
	check();
	await mkdir(dirname(destination), { recursive: true });
	check();
	const staging = await mkdtemp(join(dirname(destination), ".workspace-snapshot-"));
	try {
		check();
		const paths = SNAPSHOT_PATHS.flatMap((path) =>
			path === "skills" && options?.mountedSkillsOnly
				? mountedSkillCrates(source).map((crate) => `skills/${crate}`)
				: [path],
		);
		for (const path of paths) {
			check();
			const entry = await lstat(join(source, path)).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			if (!entry) continue;
			await cp(join(source, path), join(staging, path), {
				recursive: true,
				dereference: true,
				preserveTimestamps: true,
				mode: constants.COPYFILE_FICLONE,
				filter: (entry) => {
					check();
					const parts = relative(source, entry).split(sep);
					if (parts.includes(".git")) return false;
					// Reuse the workspace cache, not standalone crate build output.
					return !(
						parts.at(-1) === "target" &&
						((parts.length === 2 && (parts[0] === "agent_lib" || parts[0] === "rlm")) ||
							(parts.length === 3 && parts[0] === "skills"))
					);
				},
			});
		}
		check();
		await mkdir(join(staging, "cell", "src"), { recursive: true });
		await writeFile(join(staging, "cell", "src", "main.rs"), "fn main() {}\n");
		await writeFile(join(staging, INHERITED_MARKER), "1\n");
		check();
		renameSync(staging, destination);
	} finally {
		await rm(staging, { recursive: true, force: true });
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
