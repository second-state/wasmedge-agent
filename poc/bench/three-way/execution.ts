import { cellComparable } from "./cell-contract.js";
import type { RunResult, Span } from "./types.js";
import { isWasmVariant } from "./types.js";

export interface CellExecutionRun {
	runId: string;
	caseId: string;
	variantId: string;
	repetition: number;
	runtime: "Python" | "Rust / Wasm";
	state: "measured" | "unavailable" | "excluded";
	cellCalls: number;
	measuredCells: number;
	successfulCells: number;
	runtimeFailures: number;
	compileFailures: number;
	aotFailures: number;
	missingCells: number;
	zeroResolutionCells: number;
	totalExecutionMs: number | null;
	successfulExecutionMs: number | null;
	failedExecutionMs: number | null;
	meanSuccessfulCellMs: number | null;
	executionSpanIds: string[];
}

export function cellExecution(run: RunResult, spans: readonly Span[]): CellExecutionRun {
	const local = spans.filter((span) => span.runId === run.runId),
		rust = isWasmVariant(run.variantId);
	const envelopes = local.filter(
		(span) =>
			span.name === "cell.roundtrip" ||
			(span.name === "tool.execution" && span.attributes.toolName === (rust ? "rust" : "ipython")),
	);
	const execution = local.filter((span) => span.name === (rust ? "cell.execution" : "cell.python_execute"));
	const identity = (span: Span) => span.cellId ?? span.toolCallId;
	const calls = new Map<string, Span>();
	let ambiguous = false;
	for (const span of envelopes) {
		const id = identity(span);
		if (!id || calls.has(id)) ambiguous = true;
		else calls.set(id, span);
	}
	const result: CellExecutionRun = {
		runId: run.runId,
		caseId: run.caseId,
		variantId: run.variantId,
		repetition: run.repetition,
		runtime: rust ? "Rust / Wasm" : "Python",
		state: "unavailable",
		cellCalls: envelopes.length,
		measuredCells: 0,
		successfulCells: 0,
		runtimeFailures: 0,
		compileFailures: 0,
		aotFailures: 0,
		missingCells: 0,
		zeroResolutionCells: 0,
		totalExecutionMs: null,
		successfulExecutionMs: null,
		failedExecutionMs: null,
		meanSuccessfulCellMs: null,
		executionSpanIds: execution.map((span) => span.spanId),
	};
	let successMs = 0,
		failureMs = 0;
	for (const [id, call] of calls) {
		const observations = execution.filter((span) => identity(span) === id);
		const observation = observations[0];
		const summary = local.find((span) => span.name === "cell.tool_total" && identity(span) === id);
		if (
			observations.length === 1 &&
			observation.measurementState === "not_run" &&
			local.some(
				(span) =>
					span.name === "cell.aot_compile" &&
					identity(span) === id &&
					span.outcome !== "ok" &&
					span.measurementState === "measured",
			)
		) {
			result.aotFailures++;
			continue;
		}
		if (
			observations.length === 1 &&
			observation.measurementState === "not_run" &&
			local.some((span) => span.name === "cell.compile" && identity(span) === id && span.outcome === "compile_error")
		) {
			result.compileFailures++;
			continue;
		}
		if (
			observations.length !== 1 ||
			observation.measurementState !== "measured" ||
			observation.durationMs === null ||
			!Number.isFinite(observation.durationMs) ||
			observation.durationMs < 0
		) {
			result.missingCells++;
			continue;
		}
		result.measuredCells++;
		if (observation.durationMs === 0) result.zeroResolutionCells++;
		// Older Rust execution summaries incorrectly marked runtime failures ok.
		const failed =
			observation.outcome !== "ok" ||
			(summary?.outcome !== undefined && summary.outcome !== "ok") ||
			call.outcome !== "ok";
		if (failed) {
			result.runtimeFailures++;
			failureMs += observation.durationMs;
		} else {
			result.successfulCells++;
			successMs += observation.durationMs;
		}
	}
	if (execution.some((span) => !identity(span) || !calls.has(identity(span)!))) ambiguous = true;
	if (!cellComparable(run) || run.status !== "completed" || !run.applicable || !run.checkPass)
		result.state = "excluded";
	else if (calls.size && !ambiguous && !result.missingCells) {
		result.state = "measured";
		result.totalExecutionMs = successMs + failureMs;
		result.successfulExecutionMs = successMs;
		result.failedExecutionMs = failureMs;
		result.meanSuccessfulCellMs = result.successfulCells ? successMs / result.successfulCells : null;
	}
	return result;
}
