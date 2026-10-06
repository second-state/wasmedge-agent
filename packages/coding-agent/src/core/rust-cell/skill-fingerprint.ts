import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

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
				const crateRoot = path === "." || path === "rlm" || /^skills\/[^/]+$/.test(path);
				if (name !== ".git" && !(name === "target" && crateRoot)) visit(`${path}/${name}`);
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

/** All mounted crates can be path dependencies of the skill under test. */
export function skillTestFingerprint(workspace: string): string {
	return skillSourceFingerprint(workspace, [
		"Cargo.toml",
		"agent_lib/Cargo.toml",
		"Cargo.lock",
		".cargo",
		".workspace-version",
		"rlm",
		"skills",
	]);
}
