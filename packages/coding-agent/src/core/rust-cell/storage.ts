import { lstat, opendir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionLease } from "../session-lease.js";
import { ProvisioningContext } from "./provisioning.js";
import { acquireWorkspaceLease } from "./workspace-lease.js";
import { readWorkspaceVersion, WORKSPACE_VERSION_FILE } from "./workspace-version.js";

const CATEGORIES = ["cache", "dependencies", "state", "history", "sources", "scratch", "other"] as const;
type Category = (typeof CATEGORIES)[number];

export interface StorageUsage {
	category: Category;
	logicalBytes: number;
	files: number;
	symlinks: number;
}

export interface WorkspaceStorageReport {
	workspace: string;
	logicalBytes: number;
	categories: StorageUsage[];
	prune?: {
		path: string;
		logicalBytes: number;
		applied: boolean;
	};
}

export interface WorkspaceStorageOptions {
	pruneCache?: boolean;
	apply?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function categoryFor(name: string): Category {
	if (name === "target") return "cache";
	if (name === "vendor") return "dependencies";
	if (name === "state") return "state";
	if (name === ".git") return "history";
	if (name === ".scratch") return "scratch";
	if (
		[
			"agent_lib",
			"cell",
			"rlm",
			"skills",
			".cargo",
			"Cargo.toml",
			"Cargo.lock",
			WORKSPACE_VERSION_FILE,
			".skills-hash",
			".cell-dependencies.json",
		].includes(name)
	)
		return "sources";
	return "other";
}

async function validateWorkspace(workspace: string, context: ProvisioningContext): Promise<void> {
	for (const name of [
		"Cargo.toml",
		"agent_lib/Cargo.toml",
		"cell/Cargo.toml",
		"rlm/Cargo.toml",
		WORKSPACE_VERSION_FILE,
	]) {
		context.check();
		const stat = await lstat(join(workspace, name));
		if (!stat.isFile() || (name === WORKSPACE_VERSION_FILE && stat.size > 1024 * 1024)) {
			throw new Error(`Not a versioned Rust cell workspace: ${workspace} (${name})`);
		}
	}
	context.check();
	if (!readWorkspaceVersion(workspace)) throw new Error(`Not a versioned Rust cell workspace: ${workspace}`);
}

async function measure(
	workspace: string,
	context: ProvisioningContext,
	cacheDevice?: number,
): Promise<WorkspaceStorageReport> {
	const categories = CATEGORIES.map((category) => ({ category, logicalBytes: 0, files: 0, symlinks: 0 }));
	const buckets = new Map(categories.map((usage) => [usage.category, usage]));
	async function visit(path: string, usage: StorageUsage): Promise<void> {
		context.check();
		const stat = await lstat(path);
		context.check();
		if (usage.category === "cache" && cacheDevice !== undefined && stat.dev !== cacheDevice) {
			throw new Error(`Cache crosses filesystem boundaries: ${path}`);
		}
		if (stat.isSymbolicLink()) {
			usage.logicalBytes += stat.size;
			usage.symlinks++;
		} else if (stat.isFile()) {
			usage.logicalBytes += stat.size;
			usage.files++;
		} else if (stat.isDirectory()) {
			const directory = await opendir(path);
			for await (const entry of directory) await visit(join(path, entry.name), usage);
		} else {
			throw new Error(`Cannot measure special filesystem entry: ${path}`);
		}
	}
	const root = await opendir(workspace);
	for await (const entry of root) await visit(join(workspace, entry.name), buckets.get(categoryFor(entry.name))!);
	context.check();
	return { workspace, logicalBytes: categories.reduce((total, usage) => total + usage.logicalBytes, 0), categories };
}

export function createStorageContext(options: WorkspaceStorageOptions): ProvisioningContext {
	if (options.apply && !options.pruneCache) throw new Error("--apply requires --prune-cache");
	const timeoutMs = options.timeoutMs ?? 300_000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
		throw new Error("Storage timeoutMs must be an integer between 1 and 2147483647");
	}
	return new ProvisioningContext(options.signal ?? new AbortController().signal, timeoutMs, "Workspace storage");
}

/** Explicit maintenance of one managed workspace; no model or toolchain startup. */
export async function inspectWorkspaceStorage(
	path: string,
	options: WorkspaceStorageOptions = {},
): Promise<WorkspaceStorageReport> {
	const context = createStorageContext(options);
	let lease: SessionLease | undefined;
	try {
		context.check();
		const workspace = await realpath(path);
		await validateWorkspace(workspace, context);
		if (options.pruneCache) {
			lease = await acquireWorkspaceLease(workspace, context, false);
			await validateWorkspace(workspace, context);
		}
		const target = join(workspace, "target");
		const targetStat = options.pruneCache
			? await lstat(target).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return undefined;
					throw error;
				})
			: undefined;
		if (targetStat && (!targetStat.isDirectory() || targetStat.dev !== (await lstat(workspace)).dev)) {
			throw new Error(`Cache must be a real directory on the workspace filesystem: ${target}`);
		}
		const report = await measure(workspace, context, targetStat?.dev);
		if (options.pruneCache) {
			report.prune = { path: target, logicalBytes: report.categories[0].logicalBytes, applied: false };
			context.check();
			if (options.apply && targetStat) {
				const current = await lstat(target);
				if (!current.isDirectory() || current.dev !== targetStat.dev || current.ino !== targetStat.ino) {
					throw new Error(`Cache changed during inspection; retry: ${target}`);
				}
				context.check();
				// Keep ownership until deletion has drained, including after cancellation.
				await rm(target, { recursive: true });
				context.check();
				report.prune.applied = true;
			}
		}
		return report;
	} finally {
		lease?.release();
		context.dispose();
	}
}
