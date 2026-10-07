/** Monotonic wall time for non-overlapping phases of one admitted cell. */
export const CELL_PHASES = [
	"prepareMs",
	"skillValidationMs",
	"libraryTestsMs",
	"buildQueueMs",
	"cargoMs",
	"rollbackMs",
	"importPolicyMs",
	"probeMs",
	"executionMs",
	"bridgeCleanupMs",
	"snapshotMs",
	"otherMs",
] as const;
export type CellPhase = (typeof CELL_PHASES)[number];

export type CellTimings = Record<CellPhase, number> & {
	version: 1;
	/** Waiting behind another cell on this runner; outside durationMs/deadline. */
	queueMs: number;
};

export class CellTimer {
	readonly started = performance.now();
	private readonly phases = Object.fromEntries(CELL_PHASES.map((key) => [key, 0])) as Record<CellPhase, number>;

	start(phase: CellPhase): () => void {
		const started = performance.now();
		let stopped = false;
		return () => {
			if (!stopped) this.phases[phase] += performance.now() - started;
			stopped = true;
		};
	}

	async measure<T>(phase: CellPhase, action: () => Promise<T>): Promise<T> {
		const stop = this.start(phase);
		try {
			return await action();
		} finally {
			stop();
		}
	}

	finish(queueMs: number): { durationMs: number; timings: CellTimings } {
		const durationMs = performance.now() - this.started;
		const measured = Object.values(this.phases).reduce((sum, value) => sum + value, 0);
		return {
			durationMs,
			timings: { ...this.phases, otherMs: Math.max(0, durationMs - measured), version: 1, queueMs },
		};
	}
}
