import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditCellContract, cellComparable } from "./cell-contract.js";
import { buildChartData } from "./charts.js";
import { dashboard } from "./dashboard.js";
import { readJson, record, writeJson } from "./files.js";
import type { Manifest, RunResult, Span } from "./types.js";

export function quantile(values: number[], q: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b),
		position = (sorted.length - 1) * q,
		lower = Math.floor(position);
	return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

export function csv(rows: Record<string, unknown>[], columns: string[]): string {
	const field = (value: unknown) => {
		const text =
			value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
		return `"${text.replaceAll('"', '""')}"`;
	};
	return `${columns.map(field).join(",")}\n${rows.map((row) => columns.map((key) => field(row[key])).join(",")).join("\n")}\n`;
}

export function analyze(directory: string): Record<string, unknown> {
	const manifest = readJson(join(directory, "manifest.json")) as Manifest;
	const runs: RunResult[] = [],
		spans: Span[] = [],
		requests: Record<string, unknown>[] = [];
	const unexecuted: string[] = [];
	for (const slot of manifest.runs) {
		const runDir = join(directory, "runs", slot.runId),
			path = join(runDir, "result.json");
		if (!existsSync(path)) {
			unexecuted.push(slot.runId);
			continue;
		}
		const result = readJson(path) as RunResult;
		if (result.checkerPass === undefined) result.checkerPass = result.checkPass;
		const item = manifest.cases.find((item) => item.id === slot.caseId);
		if (item) result.cellContract = auditCellContract(runDir, item, slot.variantId);
		runs.push(result);
		const spanFile = join(runDir, "spans.jsonl");
		if (existsSync(spanFile))
			for (const line of readFileSync(spanFile, "utf8").split("\n").filter(Boolean))
				spans.push(JSON.parse(line) as Span);
		for (const name of readdirSync(runDir).filter((name) => /^request-\d+\.json$/.test(name))) {
			const value = readJson(join(runDir, name));
			if (record(value))
				requests.push({ runId: slot.runId, variantId: slot.variantId, caseId: slot.caseId, ...value });
		}
	}
	const phaseGroups = new Map<string, Span[]>();
	for (const span of spans) {
		const key = JSON.stringify([span.benchmarkId, span.variantId, span.name, span.measurementState, span.outcome]);
		const group = phaseGroups.get(key) ?? [];
		group.push(span);
		phaseGroups.set(key, group);
	}
	const phaseSummary = [...phaseGroups.values()].map((group) => ({
		caseId: group[0].benchmarkId,
		variantId: group[0].variantId,
		phase: group[0].name,
		state: group[0].measurementState,
		outcome: group[0].outcome,
		samples: group.length,
		medianMs: quantile(
			group.flatMap((span) => (span.durationMs === null ? [] : [span.durationMs])),
			0.5,
		),
		p95Ms:
			group.length >= 20
				? quantile(
						group.flatMap((span) => (span.durationMs === null ? [] : [span.durationMs])),
						0.95,
					)
				: null,
		reason: group[0].reason ?? null,
	}));
	const taskSummary = manifest.cases.flatMap((item) =>
		manifest.variants.map((variant) => {
			const group = runs.filter((run) => run.caseId === item.id && run.variantId === variant.id),
				valid = group.filter((run) => run.status === "completed" && run.applicable !== false),
				passed = valid.filter((run) => run.checkPass),
				comparable = passed.filter(cellComparable);
			return {
				caseId: item.id,
				lane: item.lane,
				scale: item.scale,
				cacheCondition: item.cacheCondition,
				variantId: variant.id,
				planned: manifest.runs.filter((run) => run.caseId === item.id && run.variantId === variant.id).length,
				recorded: group.length,
				infrastructureErrors: group.filter((run) => run.status !== "completed").length,
				passed: passed.length,
				cellComparisonSamples: comparable.length,
				correctnessRate: valid.length ? passed.length / valid.length : null,
				medianAgentMs: quantile(
					comparable.flatMap((run) => (run.agentElapsedMs === null ? [] : [run.agentElapsedMs])),
					0.5,
				),
				penalizedMeanMs:
					valid.length && valid.every((run) => run.cellContract?.status !== "not-controlled")
						? valid.reduce(
								(total, run) =>
									total +
									(run.checkPass && run.agentElapsedMs !== null ? run.agentElapsedMs : item.taskBudgetMs),
								0,
							) / valid.length
						: null,
				repetitions: group.length,
				statisticalStatus:
					valid.length < 5 ? "smoke-insufficient-samples" : "descriptive-only-overhead-not-audited",
				parameters: item.parameters,
			};
		}),
	);
	const integrityErrors: string[] = [];
	const spanIds = new Set(spans.map((span) => span.spanId));
	for (const span of spans) {
		if (span.parentSpanId && !spanIds.has(span.parentSpanId))
			integrityErrors.push(`Missing parent: ${span.recordId}`);
		if (span.measurementState === "measured") {
			if (
				!span.startMonoNs ||
				!span.endMonoNs ||
				span.durationMs === null ||
				BigInt(span.endMonoNs) < BigInt(span.startMonoNs) ||
				Math.abs(Number(BigInt(span.endMonoNs) - BigInt(span.startMonoNs)) / 1e6 - span.durationMs) > 0.001
			)
				integrityErrors.push(`Invalid clock/duration: ${span.recordId}`);
		}
	}
	const charts = buildChartData(manifest.cases, manifest.variants, manifest.runs, runs, spans);
	const cellRuns = runs.filter((run) => run.cellContract?.status !== "not-applicable");
	const report = {
		version: 1,
		planCreatedAt: manifest.createdAt,
		generatedAt: new Date().toISOString(),
		modelId: manifest.provider?.modelId ?? null,
		modelIdentity: manifest.provider?.modelIdentity ?? null,
		complete: unexecuted.length === 0 && runs.every((run) => run.status === "completed"),
		rankingAllowed: false,
		rankingBlockedReasons: [
			"Collector overhead has not been audited against the 2% gate",
			...(taskSummary.some((item) => item.repetitions < 5)
				? ["Smoke sample counts do not support a performance verdict"]
				: []),
			...(unexecuted.length || integrityErrors.length || runs.some((run) => run.status !== "completed")
				? ["Missing or invalid run slots"]
				: []),
		],
		unexecuted,
		integrityErrors,
		plannedRuns: manifest.runs.length,
		recordedRuns: runs.length,
		paidRequests: runs
			.filter((run) => run.modelId !== "replay-fixed-v1" && run.modelId !== "none-direct-runtime")
			.reduce((sum, run) => sum + run.requestCount, 0),
		taskSummary,
		phaseSummary,
		cellComparison: {
			endToEndRuns: cellRuns.length,
			compliantRuns: cellRuns.filter((run) => run.cellContract?.status === "compliant").length,
			violatedRuns: cellRuns.filter((run) => run.cellContract?.status === "violated").length,
			notControlledRuns: cellRuns.filter((run) => run.cellContract?.status === "not-controlled").length,
			purpose: "Python cell + Python runtime vs Rust cell + Wasm runtime",
			runs: cellRuns.map((run) => ({
				runId: run.runId,
				caseId: run.caseId,
				variantId: run.variantId,
				...run.cellContract,
			})),
		},
		compilationScope: "all-run-cargo-and-aot-command-wall-v1",
		allCompilationAdjustedSummary: charts.cases.map((row) => ({
			caseId: row.caseId,
			variantId: row.variantId,
			...row.withoutAllCompilation,
		})),
		compilationAdjustedRuns: charts.compilationRuns,
		compilationAdjustedSummary: charts.cases.map((row) => ({
			caseId: row.caseId,
			variantId: row.variantId,
			...row.withoutCompilation,
		})),
		cellExecutionRuns: charts.executionRuns,
	};
	writeJson(join(directory, "report.json"), report);
	writeFileSync(
		join(directory, "runs.csv"),
		csv(
			runs.map((run) => ({ ...run })),
			[
				"runId",
				"caseId",
				"variantId",
				"repetition",
				"modelId",
				"status",
				"checkPass",
				"checkerPass",
				"cellContract",
				"timedOut",
				"agentElapsedMs",
				"userElapsedMs",
				"validatedElapsedMs",
				"cargoCapture",
				"aotCapture",
				"requestCount",
				"error",
			],
		),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(directory, "phases.csv"),
		csv(
			spans.map((span) => ({ ...span, attributes: span.attributes })),
			[
				"runId",
				"benchmarkId",
				"variantId",
				"name",
				"measurementState",
				"outcome",
				"durationMs",
				"clockId",
				"startMonoNs",
				"endMonoNs",
				"parentSpanId",
				"turnId",
				"requestId",
				"toolCallId",
				"cellId",
				"reason",
				"attributes",
			],
		),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(directory, "phase-summary.csv"),
		csv(phaseSummary, ["caseId", "variantId", "phase", "state", "outcome", "samples", "medianMs", "p95Ms", "reason"]),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(directory, "requests.csv"),
		csv(requests, [
			"runId",
			"caseId",
			"variantId",
			"requestId",
			"upstreamStatus",
			"responseBytes",
			"toolCount",
			"usage",
		]),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(directory, "compilation-adjusted-runs.csv"),
		csv(
			charts.compilationRuns.map((run) => ({ ...run })),
			[
				"runId",
				"caseId",
				"variantId",
				"repetition",
				"state",
				"reason",
				"agentMs",
				"userMs",
				"validatedMs",
				"compileMs",
				"agentCargoMs",
				"userCargoMs",
				"validatedCargoMs",
				"agentWithoutCompilationMs",
				"userWithoutCompilationMs",
				"validatedWithoutCompilationMs",
				"aotCompileMs",
				"agentAotMs",
				"userAotMs",
				"validatedAotMs",
				"agentCompilerMs",
				"userCompilerMs",
				"validatedCompilerMs",
				"agentWithoutAllCompilationMs",
				"userWithoutAllCompilationMs",
				"validatedWithoutAllCompilationMs",
				"aotSpanIds",
				"compileObservations",
				"compileSpanIds",
			],
		),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(directory, "cell-execution-runs.csv"),
		csv(
			charts.executionRuns.map((run) => ({ ...run })),
			[
				"runId",
				"caseId",
				"variantId",
				"repetition",
				"runtime",
				"state",
				"cellCalls",
				"measuredCells",
				"successfulCells",
				"runtimeFailures",
				"compileFailures",
				"aotFailures",
				"missingCells",
				"zeroResolutionCells",
				"totalExecutionMs",
				"successfulExecutionMs",
				"failedExecutionMs",
				"meanSuccessfulCellMs",
				"executionSpanIds",
			],
		),
		{ mode: 0o600 },
	);
	writeFileSync(join(directory, "report.html"), dashboard(report, manifest, runs, spans, charts), { mode: 0o600 });
	return report;
}
