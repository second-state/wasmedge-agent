import { cellComparable } from "./cell-contract.js";
import { type CompilationAdjustedRun, subtractCompilation } from "./compilation.js";
import { type CellExecutionRun, cellExecution } from "./execution.js";
import type { Case, RunResult, RunSlot, Span, Variant } from "./types.js";

export interface RunCounts {
	passed: number;
	failed: number;
	infrastructure: number;
	notApplicable: number;
	unexecuted: number;
}

export interface ChartCase {
	caseId: string;
	lane: string;
	scale: string;
	variantId: string;
	planned: number;
	counts: RunCounts;
	successSamples: number;
	contractExcludedSamples: number;
	agentMs: number | null;
	userMs: number | null;
	validatedMs: number | null;
	penalizedMs: number | null;
	withoutCompilation: {
		agentMs: number | null;
		userMs: number | null;
		validatedMs: number | null;
		rawValidatedMs: number | null;
		validatedSamples: number;
		rawAgentMs: number | null;
		rawUserMs: number | null;
		agentSamples: number;
		userSamples: number;
		unavailableSamples: number;
		states: Record<string, number>;
	};
	withoutAllCompilation: {
		agentMs: number | null;
		userMs: number | null;
		validatedMs: number | null;
		rawAgentMs: number | null;
		rawUserMs: number | null;
		rawValidatedMs: number | null;
		agentSamples: number;
		userSamples: number;
		validatedSamples: number;
		unavailableSamples: number;
	};
}

export interface ChartPhase {
	caseId: string;
	variantId: string;
	phase: string;
	medianMs: number | null;
	observations: number;
	errorObservations: number;
	states: Record<string, number>;
}

function median(values: (number | null)[]): number | null {
	const sorted = values
		.filter((value): value is number => value !== null && Number.isFinite(value))
		.sort((a, b) => a - b);
	if (!sorted.length) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildChartData(
	cases: readonly (Pick<Case, "id" | "lane" | "scale" | "taskBudgetMs"> & Partial<Pick<Case, "tools">>)[],
	variants: readonly Pick<Variant, "id">[],
	slots: readonly RunSlot[],
	runs: readonly RunResult[],
	spans: readonly Span[],
): {
	cases: ChartCase[];
	phases: ChartPhase[];
	compilationRuns: CompilationAdjustedRun[];
	executionRuns: CellExecutionRun[];
} {
	const byRun = new Map(runs.map((run) => [run.runId, run]));
	const compilationRuns = runs.map((run) =>
		subtractCompilation(
			run,
			spans,
			cases.find((item) => item.id === run.caseId),
		),
	);
	const compilationByRun = new Map(compilationRuns.map((run) => [run.runId, run]));
	const rows = cases.flatMap((item) =>
		variants.map((variant) => {
			const planned = slots.filter((slot) => slot.caseId === item.id && slot.variantId === variant.id);
			const counts: RunCounts = { passed: 0, failed: 0, infrastructure: 0, notApplicable: 0, unexecuted: 0 };
			const successes: RunResult[] = [];
			const penalties: number[] = [];
			let contractExcludedSamples = 0;
			for (const slot of planned) {
				const run = byRun.get(slot.runId);
				if (!run || run.status === "planned" || run.status === "running") counts.unexecuted++;
				else if (run.status === "infrastructure_error") counts.infrastructure++;
				else if (run.applicable === false) counts.notApplicable++;
				else {
					if (run.checkPass) {
						counts.passed++;
						if (cellComparable(run)) successes.push(run);
						else contractExcludedSamples++;
					} else counts.failed++;
					if (run.cellContract?.status !== "not-controlled")
						penalties.push(run.checkPass && run.agentElapsedMs !== null ? run.agentElapsedMs : item.taskBudgetMs);
				}
			}
			const adjusted = successes.map((run) => compilationByRun.get(run.runId)!);
			const agents = adjusted.filter((run) => run.agentWithoutCompilationMs !== null);
			const users = adjusted.filter((run) => run.userWithoutCompilationMs !== null);
			const validated = adjusted.filter((run) => run.validatedWithoutCompilationMs !== null);
			const allAgents = adjusted.filter((run) => run.agentWithoutAllCompilationMs !== null);
			const allUsers = adjusted.filter((run) => run.userWithoutAllCompilationMs !== null);
			const allValidated = adjusted.filter((run) => run.validatedWithoutAllCompilationMs !== null);
			const states: Record<string, number> = {};
			for (const run of adjusted) states[run.state] = (states[run.state] ?? 0) + 1;
			return {
				caseId: item.id,
				lane: item.lane,
				scale: item.scale,
				variantId: variant.id,
				planned: planned.length,
				counts,
				successSamples: successes.length,
				contractExcludedSamples,
				agentMs: median(successes.map((run) => run.agentElapsedMs)),
				userMs: median(successes.map((run) => run.userElapsedMs)),
				validatedMs: median(successes.map((run) => run.validatedElapsedMs ?? null)),
				penalizedMs: penalties.length ? penalties.reduce((sum, value) => sum + value, 0) / penalties.length : null,
				withoutCompilation: {
					agentMs: median(agents.map((run) => run.agentWithoutCompilationMs)),
					userMs: median(users.map((run) => run.userWithoutCompilationMs)),
					validatedMs: median(validated.map((run) => run.validatedWithoutCompilationMs)),
					validatedSamples: validated.length,
					rawValidatedMs: median(validated.map((run) => run.validatedMs)),
					rawAgentMs: median(agents.map((run) => run.agentMs)),
					rawUserMs: median(users.map((run) => run.userMs)),
					agentSamples: agents.length,
					userSamples: users.length,
					unavailableSamples: adjusted.filter((run) => run.state === "unavailable").length,
					states,
				},
				withoutAllCompilation: {
					agentMs: median(allAgents.map((run) => run.agentWithoutAllCompilationMs)),
					userMs: median(allUsers.map((run) => run.userWithoutAllCompilationMs)),
					validatedMs: median(allValidated.map((run) => run.validatedWithoutAllCompilationMs)),
					rawAgentMs: median(allAgents.map((run) => run.agentMs)),
					rawUserMs: median(allUsers.map((run) => run.userMs)),
					rawValidatedMs: median(allValidated.map((run) => run.validatedMs)),
					agentSamples: allAgents.length,
					userSamples: allUsers.length,
					validatedSamples: allValidated.length,
					unavailableSamples: adjusted.filter((run) => run.validatedWithoutAllCompilationMs === null).length,
				},
			};
		}),
	);
	const groups = new Map<string, Span[]>();
	for (const span of spans) {
		const key = JSON.stringify([span.benchmarkId, span.variantId, span.name]);
		const group = groups.get(key) ?? [];
		group.push(span);
		groups.set(key, group);
	}
	const phases = [...groups.values()].map((group) => {
		const measured = group.filter((span) => span.measurementState === "measured" && span.durationMs !== null);
		const states: Record<string, number> = {};
		for (const span of group) states[span.measurementState] = (states[span.measurementState] ?? 0) + 1;
		return {
			caseId: group[0].benchmarkId,
			variantId: group[0].variantId,
			phase: group[0].name,
			medianMs: median(measured.map((span) => span.durationMs)),
			observations: measured.length,
			errorObservations: measured.filter((span) => span.outcome !== "ok").length,
			states,
		};
	});
	return { cases: rows, phases, compilationRuns, executionRuns: runs.map((run) => cellExecution(run, spans)) };
}
