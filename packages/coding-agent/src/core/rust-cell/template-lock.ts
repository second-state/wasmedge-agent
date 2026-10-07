import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { lockSync } from "proper-lockfile";
import type { ProvisioningContext } from "./provisioning.js";

interface Owner {
	version: 1;
	pid: number;
	hostname: string;
	token: string;
}

const held = new Set<string>();
const RETRY_MS = 50;
const SYNC_WAIT_MS = 300_000;

export function templatePreparationActive(template: string): boolean {
	return existsSync(`${template}.prepare-owner`) || existsSync(`${template}.prepare-owner.guard`);
}

function readOwner(path: string): Owner | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const owner = JSON.parse(raw) as Partial<Owner> | null;
	if (
		!owner ||
		owner.version !== 1 ||
		!Number.isSafeInteger(owner.pid) ||
		(owner.pid ?? 0) <= 0 ||
		typeof owner.hostname !== "string" ||
		typeof owner.token !== "string" ||
		!owner.token
	) {
		throw new Error(`Invalid template preparation lock: ${path}`);
	}
	return owner as Owner;
}

function ownerAlive(owner: Owner, path: string): boolean {
	if (owner.hostname !== hostname()) {
		throw new Error(`Template preparation lock belongs to another host: ${path}`);
	}
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (error) {
		// EPERM and unknown errors cannot establish that the owner has exited.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function tryAcquire(template: string): (() => void) | undefined {
	if (held.has(template)) return undefined;
	// Keep coordination files beside the template, outside cloned workspaces.
	const path = `${template}.prepare-owner`;
	let compromised: Error | undefined;
	let unlock: () => void;
	try {
		// This guard covers only synchronous metadata mutations, never a build.
		unlock = lockSync(path, {
			realpath: false,
			lockfilePath: `${path}.guard`,
			stale: 30_000,
			onCompromised: (error) => {
				compromised = error;
			},
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
		throw error;
	}
	let releaseOwner: (() => void) | undefined;
	try {
		try {
			if (compromised) throw compromised;
			const previous = readOwner(path);
			if (previous && ownerAlive(previous, path)) return undefined;
			const owner: Owner = { version: 1, pid: process.pid, hostname: hostname(), token: randomUUID() };
			const candidate = `${path}.${owner.token}.tmp`;
			try {
				writeFileSync(candidate, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
				renameSync(candidate, path);
			} finally {
				rmSync(candidate, { force: true });
			}
			held.add(template);
			let released = false;
			releaseOwner = () => {
				// Contenders never replace a live owner. The token also makes a repeated
				// release harmless after this process has acquired the template again.
				if (released) return;
				try {
					if (readOwner(path)?.token === owner.token) rmSync(path);
				} finally {
					held.delete(template);
					released = true;
				}
			};
			return releaseOwner;
		} finally {
			unlock();
		}
	} catch (error) {
		releaseOwner?.();
		throw error;
	}
}

export async function acquireTemplateLock(templateDir: string, context: ProvisioningContext): Promise<() => void> {
	const template = realpathSync(templateDir);
	for (;;) {
		context.check();
		const release = tryAcquire(template);
		if (release) return release;
		try {
			await delay(RETRY_MS, undefined, { signal: context.signal });
		} catch {
			context.check();
		}
	}
}

export function acquireTemplateLockSync(templateDir: string): () => void {
	const template = realpathSync(templateDir);
	const deadline = performance.now() + SYNC_WAIT_MS;
	const sleep = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		if (held.has(template)) throw new Error(`Template preparation already active in this process: ${template}`);
		const release = tryAcquire(template);
		if (release) return release;
		if (performance.now() >= deadline) throw new Error(`Timed out waiting for template preparation: ${template}`);
		Atomics.wait(sleep, 0, 0, RETRY_MS);
	}
}
