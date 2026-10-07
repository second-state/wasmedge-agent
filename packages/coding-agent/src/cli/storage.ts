import { inspectWorkspaceStorage, type WorkspaceStorageOptions } from "../core/rust-cell/storage.js";
import { inspectArtifactsStorage, type WorkspaceStorageInventory } from "../core/rust-cell/storage-inventory.js";

function printInventory(inventory: WorkspaceStorageInventory, options: WorkspaceStorageOptions): void {
	console.log(`Session artifacts: ${inventory.artifactsRoot}`);
	console.log("Logical sizes before removal (not allocated or reclaimable disk space):");
	for (const entry of inventory.workspaces) {
		if (entry.status !== "ok") {
			console.log(`  ${entry.status}: ${entry.workspace}: ${entry.error}`);
			continue;
		}
		const { report } = entry;
		const cache = report.categories.find((usage) => usage.category === "cache")!.logicalBytes;
		const action = report.prune
			? report.prune.applied
				? "; cache removed"
				: options.apply
					? "; no build cache to remove"
					: "; prune preview"
			: "";
		console.log(`  ${entry.workspace}: ${report.logicalBytes} bytes (${cache} cache bytes${action})`);
	}
	const inspected = inventory.workspaces.filter((entry) => entry.status === "ok").length;
	console.log(
		`Total: ${inventory.logicalBytes} logical bytes from ${inspected}/${inventory.workspaces.length} workspaces`,
	);
	if (!inventory.complete)
		console.log("Incomplete: totals exclude skipped or failed workspaces; cache removal may be partial.");
	if (options.pruneCache && !options.apply)
		console.log("Run again with --apply to remove the available build caches.");
}

export async function runStorageCommand(args: string[]): Promise<void> {
	let workspace: string | undefined;
	let artifacts: string | undefined;
	let json = false;
	const options: WorkspaceStorageOptions = {};
	let positionalOnly = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!positionalOnly && arg === "--") positionalOnly = true;
		else if (!positionalOnly && arg === "--artifacts") {
			if (artifacts !== undefined) throw new Error("--artifacts may only be specified once");
			const value = args[++i];
			if (!value || value.startsWith("-")) throw new Error("--artifacts requires a directory path");
			artifacts = value;
		} else if (!positionalOnly && arg === "--json") json = true;
		else if (!positionalOnly && arg === "--prune-cache") options.pruneCache = true;
		else if (!positionalOnly && arg === "--apply") options.apply = true;
		else if (!positionalOnly && arg.startsWith("-")) throw new Error(`Unknown storage option: ${arg}`);
		else if (workspace === undefined) workspace = arg;
		else throw new Error("storage accepts one workspace path");
	}
	if (workspace && artifacts) throw new Error("Choose a workspace path or --artifacts, not both");
	if (!workspace && !artifacts) {
		throw new Error(
			"Usage: wasmedge-agent storage <workspace> | --artifacts <dir> [--prune-cache] [--apply] [--json]",
		);
	}
	const controller = new AbortController();
	const cancel = () => controller.abort(new Error("Workspace storage cancelled; cache removal may have completed"));
	process.on("SIGINT", cancel);
	try {
		if (artifacts) {
			const inventory = await inspectArtifactsStorage(artifacts, { ...options, signal: controller.signal });
			if (json) console.log(JSON.stringify(inventory, null, 2));
			else printInventory(inventory, options);
			if (!inventory.complete) process.exitCode = 1;
			return;
		}
		const report = await inspectWorkspaceStorage(workspace!, { ...options, signal: controller.signal });
		if (json) console.log(JSON.stringify(report, null, 2));
		else {
			console.log(`Workspace: ${report.workspace}`);
			console.log("Logical size by path (not allocated disk space; symlinks are not followed):");
			for (const usage of report.categories) {
				console.log(
					`  ${usage.category.padEnd(14)} ${(usage.logicalBytes / 1024 / 1024).toFixed(2)} MiB (${usage.files} files, ${usage.symlinks} links)`,
				);
			}
			console.log(`  Total          ${(report.logicalBytes / 1024 / 1024).toFixed(2)} MiB`);
			if (report.prune) {
				const action = report.prune.applied
					? "Removed"
					: options.apply
						? "No build cache to remove"
						: "Prune preview";
				console.log(`${action}: ${report.prune.path} (${report.prune.logicalBytes} logical bytes)`);
				if (!options.apply) console.log("Run again with --apply to remove this build cache.");
			}
		}
	} finally {
		process.removeListener("SIGINT", cancel);
	}
}
