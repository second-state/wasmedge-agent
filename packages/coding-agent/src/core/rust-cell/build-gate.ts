/** Bounds concurrent cell compiles across sessions in one process (DESIGN.md
 * §10, the kernel boot gate's successor). Unlike IO-bound kernel boots, each
 * cargo build parallelizes internally, so the gate admits few at a time. */

import { cpus } from "node:os";
import { Semaphore } from "../../utils/semaphore.js";

const DEFAULT_BUILD_CONCURRENCY = Math.max(2, Math.min(8, Math.floor((cpus().length || 4) / 2)));
// Explicit overrides may exceed the auto default, but a storm of parallel
// cargo invocations degrades every build past this point.
const MAX_BUILD_CONCURRENCY = 32;

export function resolveBuildConcurrency(): number {
	const raw = process.env.WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS;
	if (raw === undefined || !/^\d+$/.test(raw)) {
		return DEFAULT_BUILD_CONCURRENCY;
	}
	const parsed = Number.parseInt(raw, 10);
	// Malformed or out-of-range values (incl. 0, e.g. "00") fall back rather
	// than mis-bounding the gate or throwing at module load.
	if (parsed < 1) {
		return DEFAULT_BUILD_CONCURRENCY;
	}
	return Math.min(MAX_BUILD_CONCURRENCY, parsed);
}

// Resolved lazily on first build so the env override is honored whenever it is
// set before the first cell compiles, not just at import time.
let buildSemaphore: Semaphore | undefined;

export function withBuildPermit<T>(build: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!buildSemaphore) {
		buildSemaphore = new Semaphore(resolveBuildConcurrency());
	}
	return buildSemaphore.run(build, signal);
}
