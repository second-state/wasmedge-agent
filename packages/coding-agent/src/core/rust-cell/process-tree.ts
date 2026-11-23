// Each native tool worker has its own JS heap. Serialize membership changes so
// the last worker alone tears down the systemd slice after its subprocesses stop.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { ProcessResourceGroup } from "./process-group.js";
import type { ProcessLimits } from "./process-limits.js";

interface Membership {
	limits: ProcessLimits;
	owners: Record<string, number>;
}

export async function openProcessTree(agentDir: string, id: string, limits: ProcessLimits) {
	const group = new ProcessResourceGroup(limits, id);
	const dir = join(agentDir, "cell-process-trees");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, id);
	const token = randomUUID();
	async function update(joining: boolean): Promise<void> {
		const unlock = await lockfile.lock(dir, {
			retries: { retries: 100, minTimeout: 25, maxTimeout: 250 },
			stale: 120_000,
		});
		try {
			let members: Membership;
			try {
				members = JSON.parse(await readFile(path, "utf8")) as Membership;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				members = { limits, owners: {} };
			}
			for (const [key, pid] of Object.entries(members.owners)) {
				try {
					process.kill(pid, 0);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					delete members.owners[key];
				}
			}
			if (joining) {
				if (Object.keys(members.owners).length && JSON.stringify(members.limits) !== JSON.stringify(limits))
					throw new Error("A running process tree has different resource limits");
				members.limits = limits;
				members.owners[token] = process.pid;
			} else {
				delete members.owners[token];
			}
			if (!Object.keys(members.owners).length) {
				group.dispose();
				await rm(path, { force: true });
				return;
			}
			const tmp = join(dir, `${token}.tmp`);
			try {
				await writeFile(tmp, JSON.stringify(members), { mode: 0o600 });
				await rename(tmp, path);
			} finally {
				await rm(tmp, { force: true });
			}
		} finally {
			await unlock();
		}
	}
	await update(true);
	try {
		group.ensure();
	} catch (error) {
		await update(false);
		throw error;
	}
	let closed: Promise<void> | undefined;
	return { group, close: () => (closed ??= update(false)) };
}
