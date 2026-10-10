import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cellComparable } from "../cell-contract.js";
import { subtractCompilation, subtractCompilationAndModel } from "../compilation.js";
import { cellExecution } from "../execution.js";
import { record, writeJson } from "../files.js";
import type { Manifest, RunResult, Span } from "../types.js";
import { workloadTaskGuide } from "./guide.js";

const median = (values: (number | null)[]) => {
	const sorted = values.filter((n): n is number => n !== null && Number.isFinite(n)).sort((a, b) => a - b);
	return sorted.length
		? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2
		: null;
};
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const display = (value: number | null) => (value === null ? "unavailable" : value.toFixed(1));

export function workloadE2eReport(
	directory: string,
	manifest: Manifest,
	runs: RunResult[],
	spans: Span[],
	requests: Record<string, unknown>[],
): void {
	const cases = manifest.cases.filter((c) => c.lane === "end-to-end" && c.workload?.implementation === "reference");
	if (!cases.length) return;
	const rows = manifest.runs
		.filter((slot) => cases.some((c) => c.id === slot.caseId))
		.map((slot) => {
			const run = runs.find((r) => r.runId === slot.runId),
				item = cases.find((c) => c.id === slot.caseId)!,
				local = spans.filter((s) => s.runId === slot.runId),
				calls = requests.filter((r) => r.runId === slot.runId);
			const passed =
				!!run &&
				run.status === "completed" &&
				run.applicable &&
				run.checkPass === true &&
				!run.timedOut &&
				cellComparable(run);
			const sum = (name: string, expected?: number) => {
				const matches = local.filter((s) => s.name === name);
				return matches.length &&
					(expected === undefined || matches.length === expected) &&
					matches.every((s) => s.measurementState === "measured" && s.durationMs !== null)
					? matches.reduce((total, s) => total + s.durationMs!, 0)
					: null;
			};
			const usage = calls.map((r) => (record(r.usage) ? r.usage : null));
			const tokens = (field: string) =>
				calls.length &&
				usage.every((u) => u && typeof u[field] === "number" && Number.isFinite(u[field]) && Number(u[field]) >= 0)
					? usage.reduce((total, u) => total + Number(u![field]), 0)
					: null;
			const adjusted = run ? subtractCompilation(run, local, item) : null;
			const withoutModel = run ? subtractCompilationAndModel(run, local) : null;
			const execution = run ? cellExecution(run, local) : null;
			return {
				...slot,
				kind: item.workload!.kind,
				scale: item.scale,
				batches: item.workload!.batches,
				passed,
				status: run?.status ?? "missing",
				timedOut: run?.timedOut ?? false,
				error: run?.error ?? null,
				cellContract: run?.cellContract?.status ?? "missing",
				requestCount: run?.requestCount ?? 0,
				recordedRequests: calls.length,
				upstream200Requests: calls.filter((r) => r.upstreamStatus === 200 && Number(r.responseBytes) > 0).length,
				responseModelIds: [
					...new Set(
						calls.flatMap((r) =>
							Array.isArray(r.responseModelIds)
								? r.responseModelIds.filter((id): id is string => typeof id === "string")
								: [],
						),
					),
				],
				usageRequests: usage.filter(Boolean).length,
				inputTokens: tokens("prompt_tokens"),
				outputTokens: tokens("completion_tokens"),
				agentMs: run?.agentElapsedMs ?? null,
				userMs: run?.userElapsedMs ?? null,
				validatedMs: run?.validatedElapsedMs ?? null,
				validatedWithoutAllCompilationMs: adjusted?.validatedWithoutAllCompilationMs ?? null,
				validatedWithoutCompilationAndModelMs: withoutModel?.validatedWithoutCompilationAndModelMs ?? null,
				validatedModelMs: withoutModel?.validatedModelMs ?? null,
				validatedCompilerAndModelMs: withoutModel?.validatedCompilerAndModelMs ?? null,
				validatedCompilerModelOverlapMs: withoutModel?.validatedCompilerModelOverlapMs ?? null,
				compilationAndModelAdjustmentReason: withoutModel?.reason ?? "missing-run",
				compilationAdjustmentReason: adjusted?.reason ?? "missing-run",
				llmMs: sum("llm.request", run?.requestCount),
				codeEmissionMs: sum("llm.code_emission"),
				codeReadyMedianMs: median(
					local
						.filter((s) => s.name === "llm.code_ready" && s.measurementState === "measured")
						.map((s) => s.durationMs),
				),
				executionMs: execution?.totalExecutionMs ?? null,
				cellCalls: execution?.cellCalls ?? 0,
				compileFailures: execution?.compileFailures ?? 0,
				runtimeFailures: execution?.runtimeFailures ?? 0,
				cargoMs: adjusted?.validatedCargoMs ?? null,
				aotMs: adjusted?.validatedAotMs ?? null,
			};
		});
	const metrics = [
		"validatedMs",
		"validatedWithoutAllCompilationMs",
		"validatedWithoutCompilationAndModelMs",
		"llmMs",
		"executionMs",
		"codeEmissionMs",
		"codeReadyMedianMs",
		"cargoMs",
		"aotMs",
		"inputTokens",
		"outputTokens",
	] as const;
	const groups = cases.flatMap((item) =>
		manifest.variants.map((variant) => {
			const local = rows.filter((r) => r.caseId === item.id && r.variantId === variant.id),
				successful = local.filter((r) => r.passed);
			return {
				caseId: item.id,
				kind: item.workload!.kind,
				scale: item.scale,
				batches: item.workload!.batches,
				variantId: variant.id,
				planned: local.length,
				passed: successful.length,
				failedOrMissing: local.length - successful.length,
				timeouts: local.filter((r) => r.timedOut).length,
				requestsAllRuns: local.reduce((total, r) => total + r.requestCount, 0),
				...(Object.fromEntries(
					metrics.map((metric) => [metric, median(successful.map((r) => r[metric]))]),
				) as Record<(typeof metrics)[number], number | null>),
				metricSamples: Object.fromEntries(
					metrics.map((metric) => [metric, successful.filter((r) => r[metric] !== null).length]),
				),
				medianCellCalls: median(successful.map((r) => r.cellCalls)),
				compileFailuresAllRuns: local.reduce((total, r) => total + r.compileFailures, 0),
			};
		}),
	);
	const report = {
		version: 1,
		campaign: manifest.root,
		seed: manifest.seed,
		modelId: manifest.provider?.modelId,
		modelIdentity: manifest.provider?.modelIdentity,
		comparison: "model-generated-cell-runtime-e2e",
		rankingAllowed: false,
		planned: rows.length,
		passed: rows.filter((r) => r.passed).length,
		requests: rows.reduce((n, r) => n + r.requestCount, 0),
		upstream200Requests: rows.reduce((n, r) => n + r.upstream200Requests, 0),
		tasks: cases.map((item) => ({ caseId: item.id, ...workloadTaskGuide(item.workload!) })),
		rows,
		groups,
		timingBoundaries: {
			validatedMs:
				"daemon startup through model generation, all cells/repairs/final replies and external checker; excludes fixture generation and teardown",
			validatedWithoutAllCompilationMs:
				"per-run union of verified Cargo/AOT command intervals clipped to validated boundary then deducted once; includes LLM; arithmetic deduction, not a compiler-free run",
			validatedWithoutCompilationAndModelMs:
				"For each run, clip verified Cargo/AOT commands and all gateway model-request intervals to the validated boundary, merge them and deduct once, then take the median of successful samples. Overlap is not deducted twice. The remainder includes host startup/dispatch, runtime/I/O, snapshots, the checker and inter-request gaps. This is an arithmetic adjustment of the original E2E trace, not a model-free run or pure compute. Missing complete intervals, unique request IDs or a shared clock make the value unavailable.",
			adjustmentEvidence:
				"In JSON, validatedModelMs is the model-request interval union within the validated boundary; validatedCompilerAndModelMs is the combined deduction; validatedCompilerModelOverlapMs is their overlap. The LLM request sum may count concurrent requests and must not be subtracted directly.",
			llmMs: "sum of all gateway request receipt-to-stream-end durations, including errors/retries; excludes gaps between requests; may overlap cell execution",
			codeEmissionMs:
				"sum of generated code field first-to-last SSE event intervals; nested within LLM time, not additional time or provider CPU",
			codeReadyMedianMs:
				"within-run median request receipt-to-last-source-field SSE event, including wait before first code byte",
			executionMs:
				"sum of runtime-reported execution durations across all measured cells, including runtime errors, excluding Cargo/AOT; generated code and cell count can differ",
			cargoMs:
				"union of captured Cargo command intervals within validated boundary, including initialization and failed builds",
			aotMs: "union of captured AOT command intervals within validated boundary; union with Cargo only deducted once",
			tokens:
				"provider-reported input/output usage summed over every request; Anthropic input includes uncached, cache creation and cache read tokens, with native usage retained; unavailable if any request lacks valid usage",
		},
	};
	writeJson(join(directory, "workloads-e2e.json"), report);
	const tasks = `<h2>What do these three tasks do?</h2><p>Fixed-program and E2E tests use the same task specifications; in E2E, the model writes its own solution. These are total workloads per run in this campaign. Batching partitions work without increasing the total.</p><div class="tasks">${report.tasks
		.map(
			(task) =>
				`<section><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.purpose)}</p><dl>${[
					["Scale", `${task.scale} · ${task.batches} ${task.batches === 1 ? "batch" : "batches"}; ${task.work}`],
					["Input", task.input],
					["Required work", task.task],
					["Output and validation", task.output],
					["Focus", task.focus],
				]
					.map(([name, meaning]) => `<dt>${name}</dt><dd>${escapeHtml(meaning)}</dd>`)
					.join("")}</dl></section>`,
		)
		.join(
			"",
		)}</div><p>All three tasks compare every output element and verify unchanged input hashes. Printing a success marker is insufficient. Variants use identical fixtures, but generated programs and inspection/repair cell counts may differ.</p>`;
	const plots = (
		[
			["validatedMs", "E2E validated total (includes model, Cargo/AOT)"],
			["validatedWithoutAllCompilationMs", "E2E minus Cargo/AOT (includes model)"],
			["validatedWithoutCompilationAndModelMs", "E2E minus Cargo/AOT (excludes model)"],
			["llmMs", "Model request time sum"],
			["executionMs", "Runtime execution total (excludes Cargo/AOT)"],
		] as const
	)
		.map(([metric, title]) => {
			const max = Math.max(1, ...groups.flatMap((g) => (typeof g[metric] === "number" ? [Number(g[metric])] : [])));
			const bars = groups
				.map((g, index) => {
					const value = typeof g[metric] === "number" ? Number(g[metric]) : null,
						y = 26 + index * 34;
					return `<text x="0" y="${y + 15}" font-size="12">${escapeHtml(`${g.kind}/${g.scale} ${g.variantId}`)}</text>${value === null ? "" : `<rect x="300" y="${y}" width="${(value / max) * 510}" height="22" fill="${g.variantId.startsWith("wasmedge") ? "#b45309" : "#2563eb"}"/>`}<text x="${value === null ? 310 : 310 + (value / max) * 510}" y="${y + 15}" font-size="12">${value === null ? "unavailable" : `${(value / 1000).toFixed(2)} s`} · n=${g.metricSamples[metric]} · ${g.passed}/${g.planned}</text>`;
				})
				.join("");
			const note =
				metric === "validatedWithoutCompilationAndModelMs"
					? "<p>Subtract the union of Cargo/AOT and model-request intervals, counting concurrent time once. The remainder retains host work, runtime/I/O, snapshots and validation from the original E2E wall time. If model streaming overlaps a cell, that cell wall-time segment is also excluded. See Runtime execution for complete cell execution durations.</p>"
					: "";
			return `<figure id="${metric}"><figcaption>${title}</figcaption>${note}<div class="scroll"><svg role="img" aria-label="${title}" viewBox="0 0 1040 ${groups.length * 34 + 50}">${bars}</svg></div></figure>`;
		})
		.join("");
	const table = groups
		.map(
			(g) =>
				`<tr><td>${escapeHtml(g.caseId)}</td><td>${g.variantId}</td><td>${g.passed}/${g.planned}</td><td>${g.failedOrMissing}</td><td>${g.timeouts}</td><td>${g.requestsAllRuns}</td>${metrics.map((m) => `<td>${display(typeof g[m] === "number" ? Number(g[m]) : null)}<br><small>n=${g.metricSamples[m]}</small></td>`).join("")}<td>${display(g.medianCellCalls)}</td><td>${g.compileFailuresAllRuns}</td></tr>`,
		)
		.join("");
	writeFileSync(
		join(directory, "workloads-e2e.html"),
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opus 5.5 workload E2E pilot</title><style>body{font:16px system-ui;max-width:1180px;margin:24px auto;padding:0 16px;color:#172033}p,li{line-height:1.65;overflow-wrap:anywhere}a{color:#1d4ed8}.scroll{overflow-x:auto}svg{width:100%;min-width:1040px}table{border-collapse:collapse;font-size:13px}th,td{padding:8px;text-align:right;border-bottom:1px solid #ddd}td:first-child,th:first-child{text-align:left}figure{margin:28px 0}figcaption{font-weight:600}small{color:#64748b}code{overflow-wrap:anywhere}.tasks{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))}.tasks section{border:1px solid #dbe2ea;border-radius:8px;padding:16px}.tasks h3{margin-top:0}.tasks dt{font-weight:600;margin-top:12px}.tasks dd{margin:4px 0;line-height:1.65;overflow-wrap:anywhere}</style><h1>Opus 5.5 workload E2E pilot</h1><p>Model: <code>${escapeHtml(manifest.provider?.modelId ?? "missing")}</code>. Seed: ${manifest.seed}. Passed: ${report.passed}/${report.planned}. Requests: ${report.requests}; HTTP 200 with response bytes: ${report.upstream200Requests}.</p><p>The model reads inputs, generates Python/Rust cells, executes them and repairs errors; no reference source is supplied. Only standard libraries are allowed, with no numeric packages. An independent oracle checks every output element, and inputs must remain unchanged. All four variants retain their native product prompts, use runtime-cell tools only, and disable reasoning. Model identity is evidenced by the service route and returned SSE fields; an immutable backend revision is not independently verified.</p><p>Interpret this separately from the offline runtime report: it includes model wait/generation and varying cell/repair counts. Fixtures of the same scale and seed can be matched; generated programs may differ from offline references. Timings are medians of successful samples. Failures, timeouts and missing slots remain recorded, and successful latency alone establishes neither success rate nor a formal ranking.</p>${tasks}${plots}<h2>All conditions</h2><p>Times are in ms; tokens and cells are counts. Each metric has its own valid successful sample count n. Requests and compile failures include failed runs.</p><div class="scroll"><table><thead><tr><th>Condition</th><th>Variant</th><th>Passed/planned</th><th>Failed/missing</th><th>Timeouts</th><th>Requests</th>${metrics.map((m) => `<th>${m}</th>`).join("")}<th>Cell calls median</th><th>Compile failures</th></tr></thead><tbody>${table}</tbody></table></div><h2>How to read the results</h2><ul>${Object.entries(
			report.timingBoundaries,
		)
			.map(([name, meaning]) => `<li><code>${name}</code>: ${escapeHtml(meaning)}</li>`)
			.join(
				"",
			)}</ul><p>Code emission/code ready are observation windows inside LLM time and must not be added again. Runtime execution sums cells; Cargo/AOT may overlap, so the columns do not add up to E2E. The compilation-excluded chart retains model time; the model-excluded chart subtracts the union of compiler and model-request intervals. Both are arithmetic deductions from original traces, calculated per run before taking medians. Do not subtract column medians directly or interpret these as actual runs omitting compilation/model calls. This small pilot is descriptive, with no formal confidence intervals or collector-overhead audit.</p></html>`,
		{ mode: 0o600 },
	);
}
