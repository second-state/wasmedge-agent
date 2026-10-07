import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { hashWorkspaceFile } from "./workspace-files.js";

function includeEntry(path: string, name: string): boolean {
	const crateRoot = path === "." || path === "rlm" || path === "agent_lib" || /^skills\/[^/]+$/.test(path);
	return name !== ".git" && !(name === "target" && crateRoot);
}

/** Content identity, including fixtures and symlink targets, without build output. */
export function skillSourceFingerprint(root: string, paths: string[] = ["."]): string {
	const hash = createHash("sha256");
	const ancestors = new Set<string>();
	function visit(path: string): void {
		const absolute = join(root, path);
		const entry = lstatSync(absolute, { throwIfNoEntry: false });
		hash.update(JSON.stringify(path));
		if (!entry) {
			hash.update("missing");
			return;
		}
		const stat = entry.isSymbolicLink() ? statSync(absolute) : entry;
		if (stat.isDirectory()) {
			const real = realpathSync(absolute);
			if (ancestors.has(real)) throw new Error(`Skill source contains a symlink cycle: ${absolute}`);
			ancestors.add(real);
			hash.update("directory");
			for (const name of readdirSync(absolute).sort()) {
				if (includeEntry(path, name)) visit(`${path}/${name}`);
			}
			ancestors.delete(real);
		} else if (stat.isFile()) {
			hash.update(`file:${stat.mode & 0o111}:`);
			hash.update(createHash("sha256").update(readFileSync(absolute)).digest());
		} else {
			throw new Error(`Skill source must contain regular files: ${absolute}`);
		}
	}
	for (const path of paths) visit(path);
	return hash.digest("hex");
}

/** Same content identity as the synchronous maintenance path, with bounded file reads. */
export async function skillSourceFingerprintAsync(
	root: string,
	paths: string[] = ["."],
	signal?: AbortSignal,
): Promise<string> {
	const check = () => signal?.throwIfAborted();
	check();
	const hash = createHash("sha256");
	const ancestors = new Set<string>();
	async function visit(path: string): Promise<void> {
		check();
		const absolute = join(root, path);
		const entry = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		check();
		hash.update(JSON.stringify(path));
		if (!entry) {
			hash.update("missing");
			return;
		}
		const resolved = entry.isSymbolicLink() ? await stat(absolute) : entry;
		check();
		if (resolved.isDirectory()) {
			const real = await realpath(absolute);
			check();
			if (ancestors.has(real)) throw new Error(`Skill source contains a symlink cycle: ${absolute}`);
			ancestors.add(real);
			hash.update("directory");
			const names = await readdir(absolute);
			check();
			for (const name of names.sort()) {
				if (includeEntry(path, name)) await visit(`${path}/${name}`);
			}
			ancestors.delete(real);
		} else if (resolved.isFile()) {
			hash.update(`file:${resolved.mode & 0o111}:`);
			hash.update(Buffer.from(await hashWorkspaceFile(absolute, { signal, check }), "hex"));
		} else {
			throw new Error(`Skill source must contain regular files: ${absolute}`);
		}
	}
	for (const path of paths) await visit(path);
	check();
	return hash.digest("hex");
}

function testPaths(mountedSkills: readonly string[]): string[] {
	return [
		"Cargo.toml",
		"agent_lib",
		"Cargo.lock",
		".cargo",
		".workspace-version",
		"rlm",
		...[...mountedSkills].sort().map((crate) => `skills/${crate}`),
	];
}

/** Mounted crates and agent_lib can be path/dev-dependencies of skill tests. */
export function skillTestFingerprint(workspace: string, mountedSkills: readonly string[]): string {
	return skillSourceFingerprint(workspace, testPaths(mountedSkills));
}

export function skillTestFingerprintAsync(
	workspace: string,
	mountedSkills: readonly string[],
	signal?: AbortSignal,
): Promise<string> {
	return skillSourceFingerprintAsync(workspace, testPaths(mountedSkills), signal);
}
