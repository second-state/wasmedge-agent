import { inspectWorkspaceStorage, type WorkspaceStorageOptions } from "../core/rust-cell/storage.js";

export async function runStorageCommand(args: string[]): Promise<void> {
	let workspace: string | undefined;
	let json = false;
	const options: WorkspaceStorageOptions = {};
	let positionalOnly = false;
	for (const arg of args) {
		if (!positionalOnly && arg === "--") positionalOnly = true;
		else if (!positionalOnly && arg === "--json") json = true;
		else if (!positionalOnly && arg === "--prune-cache") options.pruneCache = true;
		else if (!positionalOnly && arg === "--apply") options.apply = true;
		else if (!positionalOnly && arg.startsWith("-")) throw new Error(`Unknown storage option: ${arg}`);
		else if (workspace === undefined) workspace = arg;
		else throw new Error("storage accepts one workspace path");
	}
	if (!workspace) throw new Error("Usage: wasmedge-agent storage <workspace> [--prune-cache] [--apply] [--json]");
	const controller = new AbortController();
	const cancel = () => controller.abort(new Error("Workspace storage cancelled; cache removal may have completed"));
	process.on("SIGINT", cancel);
	try {
		const report = await inspectWorkspaceStorage(workspace, { ...options, signal: controller.signal });
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
