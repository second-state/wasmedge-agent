import { createHash } from "node:crypto";
import {
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ensureWorkspaceAt } from "./workspace.js";

export const WORKSPACE_VERSION_FILE = ".workspace-version";
const HOST_PATHS = [".cargo/config.toml", "Cargo.toml", "Cargo.lock", "agent_lib/Cargo.toml", "cell/Cargo.toml", "rlm"];
const SOURCE_DIR = "agent_lib/src/";

interface WorkspaceVersion {
	schema: 1;
	templateHash: string;
	dependencyHash: string;
	configurationHash?: string;
	rustcVersion: string;
	wasmedgeVersion: string;
	/** Template defaults, not user-edited source, for the next upgrade. */
	sourceHashes: Record<string, string>;
}

interface WorkspaceVersionOptions {
	templateDir: string;
	initialWorkspaceDir?: string;
	rustcVersion: string;
	wasmedgeVersion: string;
	/** Identity of user-selected scaffold dependencies. */
	configurationHash?: string;
	/** Regenerate dependencies and skill mounts in the staged workspace. */
	configure: (workspace: string) => void;
	/** Compile only; never execute the retained cell during an upgrade. */
	validate: (workspace: string) => void;
	onProgress?: (message: string) => void;
}

function hashFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileHashes(root: string, paths: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	function visit(path: string): void {
		const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
		if (!stat) return;
		if (stat.isDirectory()) {
			for (const name of readdirSync(join(root, path)).sort()) {
				if (!["target", "vendor", ".git"].includes(name)) visit(`${path}/${name}`);
			}
		} else if (stat.isFile()) {
			result[path] = hashFile(join(root, path));
		} else {
			throw new Error(`Template scaffold must contain regular files: ${path}`);
		}
	}
	for (const path of paths) visit(path);
	return result;
}

function versionFor(options: WorkspaceVersionOptions): WorkspaceVersion {
	const files = fileHashes(options.templateDir, [...HOST_PATHS, "agent_lib/src", "cell/src"]);
	const digest = (entries: Record<string, string>) =>
		createHash("sha256").update(JSON.stringify(entries)).digest("hex");
	return {
		schema: 1,
		templateHash: digest(files),
		dependencyHash: digest(
			Object.fromEntries(Object.entries(files).filter(([path]) => /Cargo\.(toml|lock)$/.test(path))),
		),
		rustcVersion: options.rustcVersion,
		wasmedgeVersion: options.wasmedgeVersion,
		configurationHash: options.configurationHash,
		sourceHashes: Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(SOURCE_DIR))),
	};
}

function readVersion(workspace: string): WorkspaceVersion | undefined {
	const path = join(workspace, WORKSPACE_VERSION_FILE);
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return undefined;
	try {
		if (!stat.isFile()) throw new Error("not a regular file");
		const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<WorkspaceVersion>;
		if (
			value.schema !== 1 ||
			![value.templateHash, value.dependencyHash, value.rustcVersion, value.wasmedgeVersion].every(
				(field) => typeof field === "string",
			) ||
			!value.sourceHashes ||
			(value.configurationHash !== undefined && typeof value.configurationHash !== "string") ||
			typeof value.sourceHashes !== "object" ||
			Array.isArray(value.sourceHashes) ||
			!Object.entries(value.sourceHashes).every(
				([name, hash]) =>
					name.startsWith(SOURCE_DIR) && !name.split(/[\\/]/).includes("..") && typeof hash === "string",
			)
		) {
			throw new Error("unsupported schema or invalid fields");
		}
		return value as WorkspaceVersion;
	} catch (error) {
		throw new Error(`Cannot read ${path}; workspace left unchanged`, { cause: error });
	}
}

function copy(source: string, destination: string): void {
	cpSync(source, destination, {
		recursive: true,
		preserveTimestamps: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
	});
}

function transactionDir(workspace: string): string {
	return join(dirname(workspace), `.${basename(workspace)}.upgrade`);
}

/** Recover the two-rename publication if its owner exited between steps. */
function recoverUpgrade(workspace: string): void {
	const transaction = transactionDir(workspace);
	if (!existsSync(transaction)) return;
	const owner = JSON.parse(readFileSync(join(transaction, "owner.json"), "utf-8")) as { pid?: number };
	if (!Number.isInteger(owner.pid) || owner.pid! < 0)
		throw new Error(`Invalid workspace upgrade owner: ${transaction}`);
	if (owner.pid) {
		let active = true;
		try {
			process.kill(owner.pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") active = false;
		}
		if (active) throw new Error(`Workspace upgrade already running (pid ${owner.pid}): ${workspace}`);
	}
	const previous = join(transaction, "previous");
	if (existsSync(previous) && !existsSync(workspace)) renameSync(previous, workspace);
	rmSync(transaction, { recursive: true, force: true });
}

function writeVersion(workspace: string, version: WorkspaceVersion): void {
	const path = join(workspace, WORKSPACE_VERSION_FILE);
	writeFileSync(`${path}.tmp`, `${JSON.stringify(version, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
}

function updateSources(
	staged: string,
	template: string,
	previous: WorkspaceVersion | undefined,
	next: WorkspaceVersion,
): void {
	const paths = new Set([...Object.keys(previous?.sourceHashes ?? {}), ...Object.keys(next.sourceHashes)]);
	for (const path of paths) {
		const destination = join(staged, path);
		let parent = dirname(destination);
		let linked = false;
		while (parent !== staged) {
			if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) linked = true;
			parent = dirname(parent);
		}
		if (linked) continue;
		const stat = lstatSync(destination, { throwIfNoEntry: false });
		// Helpers are user-owned, and skills/mod.rs is regenerated by configure.
		if (path.startsWith(`${SOURCE_DIR}helpers/`) || path.startsWith(`${SOURCE_DIR}skills/`)) continue;
		if (stat && (!stat.isFile() || hashFile(destination) !== previous?.sourceHashes[path])) continue;
		if (!stat && previous?.sourceHashes[path]) continue; // Preserve user deletions.
		rmSync(destination, { force: true });
		if (next.sourceHashes[path]) copy(join(template, path), destination);
	}
}

/** Refresh scaffold in a separate tree; the existing workspace stays intact
 * until its retained cell and library compile against the new runtime. */
export function prepareVersionedWorkspace(dir: string, options: WorkspaceVersionOptions): void {
	const workspace = resolve(dir);
	recoverUpgrade(workspace);
	const fresh = !existsSync(join(workspace, "Cargo.toml")) && !options.initialWorkspaceDir;
	ensureWorkspaceAt(workspace, options.initialWorkspaceDir ?? options.templateDir);
	const next = versionFor(options);
	const previous = readVersion(workspace);
	if (
		previous &&
		previous.templateHash === next.templateHash &&
		previous.configurationHash === next.configurationHash &&
		previous.rustcVersion === next.rustcVersion &&
		previous.wasmedgeVersion === next.wasmedgeVersion
	)
		return;
	if (fresh && !options.configurationHash) {
		writeVersion(workspace, next);
		return;
	}
	options.onProgress?.("Upgrading the cell workspace scaffold...");
	const transaction = transactionDir(workspace);
	mkdirSync(transaction);
	writeFileSync(join(transaction, "owner.json"), JSON.stringify({ pid: process.pid }));
	const staged = join(transaction, "next");
	const backup = join(transaction, "previous");
	try {
		const retainedLock =
			next.configurationHash &&
			previous?.configurationHash === next.configurationHash &&
			existsSync(join(workspace, "Cargo.lock"))
				? readFileSync(join(workspace, "Cargo.lock"))
				: undefined;
		cpSync(workspace, staged, {
			recursive: true,
			preserveTimestamps: true,
			verbatimSymlinks: true,
			mode: constants.COPYFILE_FICLONE,
			filter: (path) => !["target", "vendor"].includes(relative(workspace, path)),
		});
		for (const path of [
			".cargo",
			"agent_lib",
			"agent_lib/src",
			"agent_lib/src/skills",
			"agent_lib/src/skills/mod.rs",
			"agent_lib/src/prelude_extra.rs",
			"agent_lib/src/lib.rs",
			"agent_lib/src/prelude.rs",
			"cell",
			"skills",
		]) {
			if (lstatSync(join(staged, path), { throwIfNoEntry: false })?.isSymbolicLink()) {
				throw new Error(`Cannot upgrade a symlinked scaffold directory: ${path}`);
			}
		}
		for (const path of [...HOST_PATHS, "vendor", "target"]) {
			rmSync(join(staged, path), { recursive: true, force: true });
			if (existsSync(join(options.templateDir, path))) copy(join(options.templateDir, path), join(staged, path));
		}
		updateSources(staged, options.templateDir, previous, next);
		if (retainedLock) writeFileSync(join(staged, "Cargo.lock"), retainedLock);
		rmSync(join(staged, ".skills-hash"), { force: true });
		options.configure(staged);
		options.validate(staged);
		writeVersion(staged, next);
		renameSync(workspace, backup);
		renameSync(staged, workspace);
	} catch (error) {
		if (existsSync(backup) && !existsSync(workspace)) renameSync(backup, workspace);
		throw new Error(
			`Workspace upgrade failed; original workspace retained at ${workspace}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	} finally {
		if (existsSync(backup) && !existsSync(workspace)) {
			// Leave a recoverable journal if restoring the original also failed.
			writeFileSync(join(transaction, "owner.json"), JSON.stringify({ pid: 0 }));
		} else {
			rmSync(transaction, { recursive: true, force: true });
		}
	}
}
