import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	acquireSessionLease,
	SESSION_LEASES_ENABLED_ENV,
	SessionAlreadyActiveError,
	type SessionLease,
} from "../session-lease.js";
import type { ProvisioningContext } from "./provisioning.js";

export class WorkspaceInUseError extends Error {
	constructor(workspace: string) {
		super(`Workspace is in use; stop its runtime before pruning the cache: ${workspace}`);
		this.name = "WorkspaceInUseError";
	}
}

async function canonicalWorkspace(path: string): Promise<string> {
	const workspace = resolve(path);
	try {
		return await realpath(workspace);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return join(await realpath(dirname(workspace)), basename(workspace));
	}
}

export async function acquireWorkspaceLease(
	path: string,
	context: ProvisioningContext,
	wait: boolean,
): Promise<SessionLease> {
	context.check();
	await mkdir(dirname(resolve(path)), { recursive: true });
	const workspace = await canonicalWorkspace(path);
	for (;;) {
		context.check();
		try {
			return acquireSessionLease(workspace, join(dirname(workspace), ".rust-cell-locks"), {
				[SESSION_LEASES_ENABLED_ENV]: "1",
			})!;
		} catch (error) {
			if (!(error instanceof SessionAlreadyActiveError)) throw error;
			if (!wait) throw new WorkspaceInUseError(workspace);
		}
		try {
			await delay(50, undefined, { signal: context.signal });
		} catch {
			context.check();
		}
	}
}
