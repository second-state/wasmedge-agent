import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ProvisioningContext } from "./provisioning.js";
import { copyWorkspacePath, hashWorkspaceFile } from "./workspace-files.js";

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
	configure: (workspace: string) => void | Promise<void>;
	/** Compile only; never execute the retained cell during an upgrade. */
	validate: (workspace: string) => void | Promise<void>;
	onProgress?: (message: string) => void;
}

async function fileHashes(
	root: string,
	paths: string[],
	context: ProvisioningContext,
): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	async function visit(path: string): Promise<void> {
		context.check();
		const fullPath = join(root, path);
		const stat = await lstat(fullPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!stat) return;
		if (stat.isDirectory()) {
			for (const name of (await readdir(fullPath)).sort()) {
				if (!["target", "vendor", ".git"].includes(name)) await visit(`${path}/${name}`);
			}
		} else if (stat.isFile()) {
			result[path] = await hashWorkspaceFile(fullPath, context);
		} else {
			throw new Error(`Template scaffold must contain regular files: ${path}`);
		}
	}
	for (const path of paths) await visit(path);
	return result;
}

async function versionFor(options: WorkspaceVersionOptions, context: ProvisioningContext): Promise<WorkspaceVersion> {
	const files = await fileHashes(options.templateDir, [...HOST_PATHS, "agent_lib/src", "cell/src"], context);
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

function transactionDir(workspace: string): string {
	return join(dirname(workspace), `.${basename(workspace)}.upgrade`);
}

/** Recover the two-rename publication if its owner exited between steps. */
export async function recoverWorkspaceUpgrade(workspace: string): Promise<void> {
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
	await rm(transaction, { recursive: true, force: true });
}

function writeVersion(workspace: string, version: WorkspaceVersion): void {
	const path = join(workspace, WORKSPACE_VERSION_FILE);
	writeFileSync(`${path}.tmp`, `${JSON.stringify(version, null, 2)}\n`);
	renameSync(`${path}.tmp`, path);
}

async function updateSources(
	staged: string,
	template: string,
	previous: WorkspaceVersion | undefined,
	next: WorkspaceVersion,
	context: ProvisioningContext,
): Promise<void> {
	const paths = new Set([...Object.keys(previous?.sourceHashes ?? {}), ...Object.keys(next.sourceHashes)]);
	for (const path of paths) {
		context.check();
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
		if (stat && (!stat.isFile() || (await hashWorkspaceFile(destination, context)) !== previous?.sourceHashes[path]))
			continue;
		if (!stat && previous?.sourceHashes[path]) continue; // Preserve user deletions.
		await rm(destination, { force: true });
		if (next.sourceHashes[path]) await copyWorkspacePath(join(template, path), destination, context);
	}
}

function matches(previous: WorkspaceVersion | undefined, next: WorkspaceVersion): boolean {
	return (
		!!previous &&
		previous.templateHash === next.templateHash &&
		previous.configurationHash === next.configurationHash &&
		previous.rustcVersion === next.rustcVersion &&
		previous.wasmedgeVersion === next.wasmedgeVersion
	);
}

function assertScaffoldDirectories(staged: string): void {
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
}

/** Prepare both initial clones and upgrades away from the live workspace. */
export async function prepareVersionedWorkspaceAsync(
	dir: string,
	options: WorkspaceVersionOptions,
	context: ProvisioningContext,
): Promise<void> {
	context.check();
	const workspace = resolve(dir);
	await recoverWorkspaceUpgrade(workspace);
	context.check();
	const root = lstatSync(workspace, { throwIfNoEntry: false });
	if (root && (!root.isDirectory() || root.isSymbolicLink())) {
		throw new Error(`Session workspace must be a directory, not a link: ${workspace}`);
	}
	const provisioned = existsSync(join(workspace, "Cargo.toml"));
	let previous = provisioned ? readVersion(workspace) : undefined;
	const next = await versionFor(options, context);
	context.check();
	if (provisioned && matches(previous, next)) return;

	options.onProgress?.(provisioned ? "Upgrading the cell workspace scaffold..." : "Cloning the cell workspace...");
	await mkdir(dirname(workspace), { recursive: true });
	context.check();
	const transaction = transactionDir(workspace);
	mkdirSync(transaction);
	writeFileSync(join(transaction, "owner.json"), JSON.stringify({ pid: process.pid }));
	const staged = join(transaction, "next");
	const backup = join(transaction, "previous");
	try {
		if (root) {
			await copyWorkspacePath(
				workspace,
				staged,
				context,
				(path) => !provisioned || !["target", "vendor"].includes(relative(workspace, path)),
			);
		}
		if (!provisioned) {
			if (root) assertScaffoldDirectories(staged);
			const source = await realpath(options.initialWorkspaceDir ?? options.templateDir);
			if (!existsSync(join(source, "Cargo.toml"))) throw new Error(`Workspace source has no Cargo.toml: ${source}`);
			await copyWorkspacePath(source, staged, context);
			previous = readVersion(staged);
		}
		const fresh = !provisioned && !options.initialWorkspaceDir;
		if (!(fresh && !options.configurationHash) && !matches(previous, next)) {
			const retainedLock =
				next.configurationHash &&
				previous?.configurationHash === next.configurationHash &&
				existsSync(join(staged, "Cargo.lock"))
					? await readFile(join(staged, "Cargo.lock"))
					: undefined;
			assertScaffoldDirectories(staged);
			for (const path of [...HOST_PATHS, "vendor", "target"]) {
				context.check();
				await rm(join(staged, path), { recursive: true, force: true });
				if (existsSync(join(options.templateDir, path))) {
					await copyWorkspacePath(join(options.templateDir, path), join(staged, path), context);
				}
			}
			await updateSources(staged, options.templateDir, previous, next, context);
			if (retainedLock) await writeFile(join(staged, "Cargo.lock"), retainedLock);
			await rm(join(staged, ".skills-hash"), { force: true });
			context.check();
			await options.configure(staged);
			context.check();
			await options.validate(staged);
		}
		context.check();
		// Keep publication synchronous: no other host task observes the gap between renames.
		writeVersion(staged, next);
		if (root) renameSync(workspace, backup);
		renameSync(staged, workspace);
	} catch (error) {
		if (existsSync(backup) && !existsSync(workspace)) renameSync(backup, workspace);
		throw new Error(
			`Workspace ${provisioned ? "upgrade failed; original workspace retained" : "creation failed; destination unchanged"} at ${workspace}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	} finally {
		if (existsSync(backup) && !existsSync(workspace)) {
			// Leave a recoverable journal if restoring the original also failed.
			writeFileSync(join(transaction, "owner.json"), JSON.stringify({ pid: 0 }));
		} else {
			await rm(transaction, { recursive: true, force: true }).finally(() => {
				if (existsSync(transaction)) writeFileSync(join(transaction, "owner.json"), JSON.stringify({ pid: 0 }));
			});
		}
	}
}
