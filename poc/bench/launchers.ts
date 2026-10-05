import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export const launcherFields = ["launcherPath", "launcherRealPath", "launcherHash"] as const;

export interface AgentLauncher {
	launcherPath: string;
	launcherRealPath: string;
	launcherHash: string;
}

export function launcherIdentity(record: unknown): string | null {
	if (!record || typeof record !== "object") return null;
	const value = record as Record<string, unknown>;
	if (!["launcherPath", "launcherRealPath"].every((key) =>
		typeof value[key] === "string" && !value[key].includes("\0") && isAbsolute(value[key])) ||
		typeof value.launcherHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.launcherHash)) return null;
	return JSON.stringify(launcherFields.map((key) => value[key]));
}

function inspectLauncher(path: string): AgentLauncher {
	const realPath = realpathSync(path);
	if (!statSync(realPath).isFile()) throw new Error("agent launcher must be a regular file");
	accessSync(realPath, constants.R_OK | constants.X_OK);
	return {
		launcherPath: path,
		launcherRealPath: realPath,
		launcherHash: `sha256:${createHash("sha256").update(readFileSync(realPath)).digest("hex")}`,
	};
}

/** Resolve once from the driver's cwd/PATH, preserving the invocation path for wrappers. */
export function resolveAgentLauncher(command: string): AgentLauncher {
	const candidates = command.includes("/") || isAbsolute(command)
		? [resolve(command)]
		: (process.env.PATH ?? "/usr/bin:/bin").split(delimiter).map((dir) => resolve(dir, command));
	for (const path of candidates) {
		try {
			return inspectLauncher(path);
		} catch {
			// PATH lookup skips directories and inaccessible candidates.
		}
	}
	throw new Error(`benchmark agent launcher is missing, unreadable, or not executable: ${command}`);
}

export function verifyAgentLauncher(expected: AgentLauncher): void {
	try {
		const identity = launcherIdentity(expected);
		if (identity && launcherIdentity(inspectLauncher(expected.launcherPath)) === identity) return;
	} catch {
		// Missing files and permission failures invalidate the saved identity too.
	}
	throw new Error(`benchmark agent launcher changed or is unavailable: ${expected.launcherPath}`);
}
