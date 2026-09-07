/**
 * The per-user daemon socket directory names, and nothing else.
 *
 * A leaf on purpose: node:os and node:path, no third-party import, nothing
 * that reaches back into the daemon. migrateAgentDirIfNeeded() needs the
 * legacy path below, and it runs as the first statement of cli-main.ts --
 * the entry whose whole design is to stay thin, which is why undici and
 * main.js under it are loaded lazily. Reading one string must not drag
 * daemon-socket.ts's lockfile dependency onto every invocation.
 *
 * Both names live here rather than one here and one there, because the only
 * thing that separates them is the product name in front of a shared suffix,
 * and a copy of that derivation is a copy that can drift.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/** The per-user suffix every socket directory of ours carries. */
function daemonSocketDirSuffix(): string {
	return typeof process.getuid === "function" ? String(process.getuid()) : "user";
}

export function defaultDaemonSocketDir(): string {
	return join(tmpdir(), `wasmedge-agent-${daemonSocketDirSuffix()}`);
}

/** Where a daemon left over from the release before the rename listens.
 *
 *  An endpoint rather than a path, because the two platforms do not agree on
 *  what one is: a unix socket file under the per-user socket directory, or a
 *  Windows named pipe. The branch mirrors defaultDaemonSocketPath()'s in
 *  daemon-socket.ts, one release behind it, and both names are preserved
 *  values rather than display names: they are what a *previously released*
 *  build created, so renaming either would not rename anything -- it would
 *  only stop finding the process that is still running.
 *
 *  Nothing here writes to it, and nothing connects to it: the one caller is
 *  the config-directory migration, which reads the endpoint to warn about it.
 *
 *  The platform is a parameter so the selection can be covered from either
 *  host; it defaults to the real one and no caller passes it. */
export function legacyDaemonEndpoint(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") {
		return "\\\\.\\pipe\\prime-agent-daemon";
	}
	return join(tmpdir(), `prime-agent-${daemonSocketDirSuffix()}`, "daemon.sock");
}
