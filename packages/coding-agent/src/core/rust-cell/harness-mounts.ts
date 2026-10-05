import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Resolve existing ancestors too: harness stores may not exist until the
 * first mutation, while their parents can already contain symlinks. */
function physicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(absolute);
		if (parent === absolute) throw error;
		return join(physicalPath(parent), basename(absolute));
	}
}

function contains(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path))
	);
}

/** A writable preopen must not expose the host's stores or their parent
 * directories. This checks configured paths, not arbitrary host-created hard
 * links or concurrent host filesystem changes. */
export function assertHarnessMountsIsolated(mounts: Record<string, string>, stores: (string | undefined)[]): void {
	const protectedPaths = stores
		.filter((store): store is string => store !== undefined)
		.flatMap((store) => [physicalPath(store), physicalPath(join(store, "harness_state.json"))]);
	for (const [guestPath, hostPath] of Object.entries(mounts)) {
		const mounted = physicalPath(hostPath);
		if (protectedPaths.some((store) => contains(mounted, store) || contains(store, mounted))) {
			throw new Error(
				`writable ${guestPath} overlaps a host harness store; move the project or session/agent storage to separate directories`,
			);
		}
	}
}

/** Readonly project access must not acquire a writable alias through another preopen. */
export function assertReadonlyWorkspaceMounts(
	project: string,
	writableMounts: Record<string, string>,
	readonlyMounts: Record<string, string>,
): void {
	const projectPath = physicalPath(project);
	for (const [guestPath, hostPath] of Object.entries({
		"/workspace": project,
		...writableMounts,
		...readonlyMounts,
	})) {
		// WasmEdge splits --dir on colons; an ambiguous path can change mount rights.
		if (hostPath.includes(":") || physicalPath(hostPath).includes(":")) {
			throw new Error(`readonly workspace policy cannot mount ${guestPath}: host paths must not contain colons`);
		}
	}
	for (const [guestPath, hostPath] of Object.entries(writableMounts)) {
		const mounted = physicalPath(hostPath);
		if (contains(mounted, projectPath) || contains(projectPath, mounted)) {
			throw new Error(
				`writable ${guestPath} overlaps the readonly /workspace; move the project and session storage to separate directories`,
			);
		}
	}
}
