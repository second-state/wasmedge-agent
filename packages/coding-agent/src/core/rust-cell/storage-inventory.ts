import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ProvisioningContext } from "./provisioning.js";
import {
	createStorageContext,
	inspectWorkspaceStorage,
	type WorkspaceStorageOptions,
	type WorkspaceStorageReport,
} from "./storage.js";
import { WorkspaceInUseError } from "./workspace-lease.js";

type WorkspaceStorageEntry =
	| { workspace: string; status: "ok"; report: WorkspaceStorageReport }
	| { workspace: string; status: "error" | "skipped"; error: string };

export interface WorkspaceStorageInventory {
	artifactsRoot: string;
	complete: boolean;
	logicalBytes: number;
	workspaces: WorkspaceStorageEntry[];
}

async function optionalStat(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function discoverWorkspaces(root: string, context: ProvisioningContext): Promise<string[]> {
	const workspaces: string[] = [];
	async function visitArtifacts(artifacts: string): Promise<void> {
		context.check();
		const directory = await opendir(artifacts);
		for await (const entry of directory) {
			context.check();
			if (entry.isDirectory() && !entry.name.startsWith(".")) await visitContainer(join(artifacts, entry.name));
		}
	}
	async function visitContainer(container: string): Promise<void> {
		context.check();
		const workspace = join(container, "workspace");
		if (await optionalStat(workspace)) workspaces.push(workspace);
		const directory = await opendir(container);
		for await (const entry of directory) {
			context.check();
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "workspace") continue;
			const child = join(container, entry.name);
			// Child transcripts live in sub-*/; their workspaces live in the
			// sibling session-artifacts/<session-id>/, recursively at each level.
			if (entry.name === "session-artifacts") await visitArtifacts(child);
			else if (
				/^sub-[0-9a-f]{8}$/.test(entry.name) ||
				(await optionalStat(join(child, "rlm-subagent.json")))?.isFile()
			)
				await visitContainer(child);
		}
	}
	await visitArtifacts(root);
	context.check();
	return workspaces.sort();
}

/** Discover the managed artifact layout before making any cache changes. */
export async function inspectArtifactsStorage(
	path: string,
	options: WorkspaceStorageOptions = {},
): Promise<WorkspaceStorageInventory> {
	const context = createStorageContext(options);
	try {
		context.check();
		const artifactsRoot = await realpath(path);
		const paths = await discoverWorkspaces(artifactsRoot, context);
		const workspaces: WorkspaceStorageEntry[] = [];
		for (const workspace of paths) {
			if (context.signal.aborted) {
				workspaces.push({ workspace, status: "skipped", error: "Not inspected: storage operation cancelled" });
				continue;
			}
			try {
				context.check();
				if (!(await lstat(workspace)).isDirectory() || (await realpath(workspace)) !== workspace) {
					throw new Error(`Discovered workspace must be a real directory without symlink ancestors: ${workspace}`);
				}
				const report = await inspectWorkspaceStorage(workspace, { ...options, signal: context.signal });
				workspaces.push({ workspace, status: "ok", report });
			} catch (error) {
				workspaces.push({
					workspace,
					status: error instanceof WorkspaceInUseError ? "skipped" : "error",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return {
			artifactsRoot,
			complete: workspaces.every((entry) => entry.status === "ok"),
			logicalBytes: workspaces.reduce(
				(sum, entry) => sum + (entry.status === "ok" ? entry.report.logicalBytes : 0),
				0,
			),
			workspaces,
		};
	} finally {
		context.dispose();
	}
}
