import { enableCompileCache } from "node:module";
import { maybeStartDaemonEarly } from "./cli/daemon-launch.js";
import {
	closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch,
	isOwnedSessionWorkerProcess,
	maybeRunOwnedSessionWorkerFrontend,
} from "./cli/owned-session-worker.js";
import { APP_NAME } from "./config.js";
import { migrateAgentDirIfNeeded } from "./migrations.js";

export async function runCli(): Promise<void> {
	try {
		enableCompileCache?.();
	} catch {
		// Read-only cache dir; startup just skips the cache.
	}

	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// This, not main(), is the real process entry, and it must run before
	// anything can resolve the agent directory. maybeStartDaemonEarly() below
	// runs before ./main.js is even imported, and its failure path writes
	// through getClientErrorLogPath(), which would create the new directory
	// first -- after which the never-clobber rule would correctly refuse the
	// move forever and strand the config in the legacy directory. main() keeps
	// its own call for embedders that import it directly; the move is
	// idempotent, so running it twice in one process costs nothing.
	migrateAgentDirIfNeeded();

	installOwnedSessionWorkerOwnerWatch();

	const args = process.argv.slice(2);
	const handledByOwnedWorker = await maybeRunOwnedSessionWorkerFrontend(args);
	if (!handledByOwnedWorker) {
		if (!isOwnedSessionWorkerProcess()) {
			// Boot a cold daemon concurrently with this process's heavy imports.
			maybeStartDaemonEarly(process.argv.slice(2));
		}
		const [{ EnvHttpProxyAgent, setGlobalDispatcher }, { main }] = await Promise.all([
			import("undici"),
			import("./main.js"),
		]);

		// undici's 300s body/headers timeouts abort long local-LLM SSE stalls; provider
		// SDKs enforce their own deadlines via retry.provider.timeoutMs.
		setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

		try {
			await main(process.argv.slice(2));
		} finally {
			closeOwnedSessionWorkerOwnerWatch();
		}
	}
}
