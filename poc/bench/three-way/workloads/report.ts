import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { subtractCompilation, unionMs } from "../compilation.js";
import { writeJson } from "../files.js";
import type { Case, Manifest, RunResult, Span } from "../types.js";
import type { WorkloadSpec } from "./cases.js";
import { cacheGuide, columnGuide, readingRules } from "./guide.js";

function median(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b),
		middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export interface WorkloadRow {
	runId: string;
	caseId: string;
	variantId: string;
	repetition: number;
	family: string;
	scale: string;
	batches: number;
	cache: string;
	implementation: string;
	format: string;
	simulationMode: string;
	passed: boolean;
	timedOut: boolean;
	error: string | null;
	roundtripMs: number | null;
	roundtripWithoutAllCompilationMs: number | null;
	validatedWithoutAllCompilationMs: number | null;
	compilationAdjustmentReason: string;
	executionMs: number | null;
	computeMs: number | null;
	cargoMs: number | null;
	aotMs: number | null;
	snapshotMs: number | null;
	validatedMs: number | null;
	warmupCells: number;
	measuredCells: number;
}
export function workloadRow(
	item: Case,
	run: RunResult | undefined,
	spans: Span[],
	repetition: number,
	variantId: string,
	runId: string,
): WorkloadRow {
	const spec = item.workload!;
	const measured = spans.filter((s) => s.attributes.warmup === false);
	const calls = measured.filter((s) => s.name === "cell.roundtrip");
	const allValid =
		calls.length === spec.batches &&
		calls.every((s) => s.measurementState === "measured" && s.outcome === "ok" && s.durationMs !== null);
	const passed =
		!!run && run.applicable && !run.timedOut && run.status === "completed" && run.checkPass === true && allValid;
	const sum = (names: string[], required = false) => {
		const observations = measured.filter((s) => names.includes(s.name) && s.measurementState === "measured");
		if (
			!passed ||
			observations.some((s) => s.durationMs === null) ||
			(required && observations.length !== spec.batches)
		)
			return null;
		if (!observations.length) return null;
		return observations.reduce((sum, s) => sum + s.durationMs!, 0);
	};
	const adjusted = run && passed ? subtractCompilation(run, spans, item) : null;
	const validatedWithoutAllCompilationMs = adjusted?.validatedWithoutAllCompilationMs ?? null;
	let roundtripWithoutAllCompilationMs: number | null = null;
	let compilationAdjustmentReason = adjusted?.reason ?? "not-successful-run";
	if (validatedWithoutAllCompilationMs !== null) {
		const clock = spans.find((s) => s.runId === runId && s.name === "run.validated_elapsed")?.clockId;
		const validCellClocks = calls.every(
			(s) =>
				typeof s.clockId === "string" &&
				s.clockId === clock &&
				!s.clockId.startsWith("duration-only:") &&
				Number.isFinite(s.durationMs) &&
				s.durationMs! >= 0 &&
				/^\d+$/.test(s.startMonoNs ?? "") &&
				/^\d+$/.test(s.endMonoNs ?? "") &&
				BigInt(s.endMonoNs!) >= BigInt(s.startMonoNs!) &&
				Math.abs(Number(BigInt(s.endMonoNs!) - BigInt(s.startMonoNs!)) / 1e6 - s.durationMs!) <= 0.001,
		);
		if (validCellClocks) {
			const commands = spans.filter(
				(s) => s.runId === runId && (s.name === "cargo.command" || s.name === "aot.command"),
			);
			const clipped = calls.flatMap((cell) =>
				commands.flatMap((command) => {
					const start =
						BigInt(command.startMonoNs!) > BigInt(cell.startMonoNs!)
							? BigInt(command.startMonoNs!)
							: BigInt(cell.startMonoNs!);
					const end =
						BigInt(command.endMonoNs!) < BigInt(cell.endMonoNs!)
							? BigInt(command.endMonoNs!)
							: BigInt(cell.endMonoNs!);
					return end > start ? [{ start, end }] : [];
				}),
			);
			roundtripWithoutAllCompilationMs = Math.max(0, sum(["cell.roundtrip"], true)! - unionMs(clipped));
			compilationAdjustmentReason = "complete-capture-union-clipped-to-measured-cells";
		} else compilationAdjustmentReason = "invalid-cell-clock";
	} else if (adjusted && ["measured", "not_run"].includes(adjusted.state))
		compilationAdjustmentReason = "missing-or-invalid-aot-capture";
	return {
		runId,
		caseId: item.id,
		variantId,
		repetition,
		family: spec.kind,
		scale: spec.scale,
		batches: spec.batches,
		cache: spec.cache,
		implementation: spec.implementation,
		format: spec.format,
		simulationMode: spec.simulationMode,
		passed,
		timedOut: run?.timedOut ?? false,
		error: run?.error ?? (run ? null : "unexecuted"),
		roundtripMs: sum(["cell.roundtrip"], true),
		roundtripWithoutAllCompilationMs,
		validatedWithoutAllCompilationMs,
		compilationAdjustmentReason,
		executionMs: sum([variantId.startsWith("wasmedge") ? "cell.execution" : "cell.python_execute"], true),
		computeMs: sum(["guest.compute", "guest.stream_compute"], true),
		cargoMs: sum(["cell.compile"], variantId.startsWith("wasmedge")),
		aotMs: sum(["cell.aot_compile"], variantId === "wasmedge-aot"),
		snapshotMs: sum(["cell.snapshot"], variantId.startsWith("wasmedge")),
		validatedMs: passed ? (run?.validatedElapsedMs ?? null) : null,
		warmupCells: spans.filter((s) => s.name === "cell.roundtrip" && s.attributes.warmup === true).length,
		measuredCells: calls.length,
	};
}

const escapeHtml = (s: unknown) =>
	String(s ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
const number = (n: number | null) => (n === null ? "—" : n.toFixed(2));
const work = (spec: WorkloadSpec) => {
	const n = (value: number) => value.toLocaleString("en-US");
	if (spec.kind === "graph") return `${n(spec.nodes)} nodes / ${n(spec.edges)} edges / ${n(spec.queries)} queries`;
	if (spec.kind === "events") return `${n(spec.events)} events / ${n(spec.keys)} keys`;
	return `${n(spec.trajectories)} trajectories × ${n(spec.steps)} steps`;
};

export function workloadReport(directory: string, manifest: Manifest, runs: RunResult[], spans: Span[]): void {
	const cases = manifest.cases.filter((c) => c.lane === "runtime" && c.workload?.implementation === "reference");
	if (!cases.length) return;
	const rows = manifest.runs.flatMap((slot) => {
		const item = cases.find((c) => c.id === slot.caseId);
		return item
			? [
					workloadRow(
						item,
						runs.find((r) => r.runId === slot.runId),
						spans.filter((s) => s.runId === slot.runId),
						slot.repetition,
						slot.variantId,
						slot.runId,
					),
				]
			: [];
	});
	const groups = cases.flatMap((item) =>
		manifest.variants.map((variant) => {
			const local = rows.filter((r) => r.caseId === item.id && r.variantId === variant.id),
				successful = local.filter((r) => r.passed);
			const value = (
				key:
					| "roundtripMs"
					| "roundtripWithoutAllCompilationMs"
					| "validatedWithoutAllCompilationMs"
					| "executionMs"
					| "computeMs"
					| "cargoMs"
					| "aotMs"
					| "snapshotMs"
					| "validatedMs",
			) => median(successful.flatMap((r) => (r[key] === null ? [] : [r[key]!])));
			return {
				caseId: item.id,
				variantId: variant.id,
				...item.workload!,
				planned: local.length,
				passed: successful.length,
				timeouts: local.filter((r) => r.timedOut).length,
				failedOrMissing: local.filter((r) => !r.passed).length,
				roundtripMs: value("roundtripMs"),
				roundtripWithoutAllCompilationMs: value("roundtripWithoutAllCompilationMs"),
				validatedWithoutAllCompilationMs: value("validatedWithoutAllCompilationMs"),
				adjustedRoundtripSamples: successful.filter((r) => r.roundtripWithoutAllCompilationMs !== null).length,
				adjustedValidatedSamples: successful.filter((r) => r.validatedWithoutAllCompilationMs !== null).length,
				executionSamples: successful.filter((r) => r.executionMs !== null).length,
				computeSamples: successful.filter((r) => r.computeMs !== null).length,
				executionMs: value("executionMs"),
				computeMs: value("computeMs"),
				cargoMs: value("cargoMs"),
				aotMs: value("aotMs"),
				snapshotMs: value("snapshotMs"),
				validatedMs: value("validatedMs"),
			};
		}),
	);
	const pairs = cases.flatMap((item) =>
		manifest.variants
			.filter((v) => v.id !== "prime-ts")
			.map((variant) => {
				const local = rows.filter((r) => r.caseId === item.id && r.variantId === variant.id);
				const ratios = local.flatMap((r) => {
					const baseline = rows.find(
						(b) => b.caseId === item.id && b.variantId === "prime-ts" && b.repetition === r.repetition,
					);
					return r.passed && baseline?.passed && r.roundtripMs && baseline.roundtripMs !== null
						? [baseline.roundtripMs / r.roundtripMs]
						: [];
				});
				return {
					caseId: item.id,
					variantId: variant.id,
					pairs: ratios.length,
					medianPairedSpeedup: median(ratios),
					confidenceInterval: null,
					rankingAllowed: false,
				};
			}),
	);
	const report = {
		version: 1,
		comparison: "fixed-algorithm-reference-only",
		includedPlannedRuns: rows.length,
		excludedPlannedRuns:
			manifest.runs.filter((s) => manifest.cases.find((c) => c.id === s.caseId)?.workload).length - rows.length,
		timingBoundaries: {
			roundtripMs: "Measured cells including Cargo, AOT, admission, execution and snapshots",
			executionMs:
				"Measured runtime execution excluding Cargo, AOT, initialization and snapshots; includes process/VM startup and I/O",
			computeMs: "Guest algorithm phase; event streaming also includes decoding and I/O",
			validatedMs:
				"Startup through disposal including warmups, Cargo, AOT, measured cells and per-batch verification",
			roundtripWithoutAllCompilationMs:
				"Per-run measured cell roundtrip sum minus the union of all verified Cargo/AOT command intervals clipped to measured cells; excludes warmups",
			validatedWithoutAllCompilationMs:
				"Per-run validated total minus the union of all verified Cargo/AOT command intervals clipped to its elapsed period; retains startup, warmups, verification and disposal",
		},
		columnGuide,
		readingRules,
		cacheGuide,
		rankingAllowed: false,
		reason: "Pilot is descriptive; instrumentation overhead and confidence intervals are not audited",
		rows,
		groups,
		pairs,
	};
	writeJson(join(directory, "workloads.json"), report);
	const columns = Object.keys(rows[0] ?? {});
	const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
	writeFileSync(
		join(directory, "workloads.csv"),
		`${columns.map(csv).join(",")}\n${rows.map((r) => columns.map((c) => csv(r[c as keyof WorkloadRow])).join(",")).join("\n")}\n`,
	);
	const metrics = [
		{
			key: "roundtripWithoutAllCompilationMs",
			label: "Roundtrip − Cargo/AOT",
			description:
				"Deduct Cargo/AOT command wall intervals within measured cells per run, then take the median. Retains admission, queueing, policy, runtime, snapshots and communication; excludes initialization, warmups and the host oracle after cell return.",
			samples: "adjustedRoundtripSamples",
		},
		{
			key: "executionMs",
			label: "Runtime execution (excludes Cargo/AOT)",
			description:
				"Directly measured runtime execution retains process/VM startup, I/O, bridge waits and output collection. It also excludes admission and snapshots, so its boundary differs from adjusted roundtrip.",
			samples: "executionSamples",
		},
		{
			key: "computeMs",
			label: "Compute (excludes Cargo/AOT)",
			description:
				"Guest algorithm phase. N01/N04 exclude separate input/index/output phases. N03 combines streaming decode, I/O and transitions and is not pure CPU time.",
			samples: "computeSamples",
		},
		{
			key: "validatedWithoutAllCompilationMs",
			label: "Validated total − Cargo/AOT",
			description:
				"Deduct all Cargo/AOT command wall intervals within each validated period, then take the median. Retains initialization, warmups, oracles, snapshots, disposal and other host costs.",
			samples: "adjustedValidatedSamples",
		},
		{
			key: "roundtripMs",
			label: "Roundtrip (includes Cargo/AOT)",
			description:
				"Complete measured cell submission/result latency, retaining every Cargo build, AOT compilation and snapshot. Compare this with adjusted charts to see the actual product cost.",
			samples: "passed",
		},
	] as const;
	const plots = metrics
		.map(
			(metric, metricIndex) =>
				`<section data-metric="${metric.key}" ${metricIndex ? "hidden" : ""}><p>${metric.description}</p>${[
					"graph",
					"events",
					"simulation",
				]
					.map((family) => {
						const local = groups.filter(
							(g) =>
								g.kind === family &&
								g.batches === 1 &&
								g.implementation === "reference" &&
								g.format === "binary" &&
								g.simulationMode === "prng",
						);
						if (!local.length) return "";
						const maximum = Math.max(1, ...local.map((g) => g[metric.key] ?? 0));
						const bars = local
							.map((g, i) => {
								const value = g[metric.key],
									width = ((value ?? 0) / maximum) * 420;
								const result = `${value === null ? "unavailable" : `${number(value)} ms`} · n=${g[metric.samples]} · passed ${g.passed}/${g.planned}`;
								return `<g><title>${escapeHtml(`${g.caseId} / ${g.variantId}: ${result}`)}</title><text x="10" y="${28 + i * 30}" font-size="12">${escapeHtml(`${g.scale} / ${g.cache} / ${g.variantId}`)}</text>${value === null ? "" : `<rect x="310" y="${14 + i * 30}" width="${width}" height="18" fill="${g.variantId.includes("wasmedge") ? "#2563eb" : "#64748b"}"/>`}<text x="${320 + width}" y="${28 + i * 30}" font-size="12">${escapeHtml(result)}</text></g>`;
							})
							.join("");
						return `<figure><figcaption>${escapeHtml(family)} · ${escapeHtml(metric.label)}</figcaption><div class="plot"><svg role="img" aria-label="${escapeHtml(`${family} ${metric.label} milliseconds`)}" viewBox="0 0 1000 ${Math.max(60, local.length * 30 + 20)}">${bars}</svg></div></figure>`;
					})
					.join("")}</section>`,
		)
		.join("");
	const cells = groups
		.map(
			(g) =>
				`<tr><td>${escapeHtml(g.caseId)}</td><td>${escapeHtml(work(g))}</td><td>${escapeHtml(g.variantId)}</td><td>${g.passed}/${g.planned}</td><td>${g.failedOrMissing}</td><td>${g.timeouts}</td>${[g.roundtripMs, g.executionMs, g.computeMs, g.cargoMs, g.aotMs, g.snapshotMs, g.validatedMs].map((n) => `<td>${number(n)}</td>`).join("")}</tr>`,
		)
		.join("");
	const guide = `<section id="columns"><h2>Detailed column definitions</h2><p>Match Condition/Work first, check completion rate next, then choose the timing boundary that answers your question.</p><div class="scroll"><table class="guide"><thead><tr><th>Column</th><th>Definition and timing boundary</th><th>How to read it</th></tr></thead><tbody>${columnGuide.map((c) => `<tr><th scope="row">${escapeHtml(c.label)}</th><td>${escapeHtml(c.meaning)}</td><td>${escapeHtml(c.reading)}</td></tr>`).join("")}</tbody></table></div><ul>${readingRules.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul></section>`;
	const caches = [...new Set(rows.map((r) => r.cache))];
	const warm = `<section id="cache"><h2>Cold versus warm</h2><p>Workspace conditions included in this comparison: ${escapeHtml(caches.join(", "))}. ${caches.includes("warm") ? "Cache conditions are reported separately; their medians are not pooled." : "This dataset is cold only. Existing warm correctness smokes have different scales/batch counts and do not establish hot speedup."}</p><ul>${cacheGuide.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul><p>A fair cold/warm comparison fixes work, cell count, source, fixture seed, algorithm and acceptance, then pairs the same repetitions with cache as an independent condition. Report total warming cost too. Faster warm runs do not imply cross-cell AOT caching or a resident VM.</p></section>`;
	const examplePython = groups.find(
		(g) =>
			g.kind === "simulation" &&
			g.scale === "large" &&
			g.cache === "cold" &&
			g.batches === 1 &&
			g.format === "binary" &&
			g.simulationMode === "prng" &&
			g.variantId === "prime-ts",
	);
	const exampleAot = groups.find((g) => g.caseId === examplePython?.caseId && g.variantId === "wasmedge-aot");
	const example =
		examplePython && exampleAot
			? `<p><strong>Reading example: </strong>Large N04 Python-TS/Wasm-AOT roundtrip medians are ${number(examplePython.roundtripMs)}/${number(exampleAot.roundtripMs)} ms, including compilation; directly measured runtime execution is ${number(examplePython.executionMs)}/${number(exampleAot.executionMs)} ms; roundtrip minus Cargo/AOT is ${number(examplePython.roundtripWithoutAllCompilationMs)}/${number(exampleAot.roundtripWithoutAllCompilationMs)} ms, retaining snapshots and other costs. These answer different questions and are not interchangeable.</p>`
			: "";
	writeFileSync(
		join(directory, "workloads.html"),
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rust cell workload pilot</title><style>body{font:16px system-ui;margin:24px auto;padding:0 16px;max-width:1180px;color:#172033}h1{font-size:28px}p,li{line-height:1.65}li{margin-bottom:8px}nav{display:flex;gap:16px;flex-wrap:wrap}a{color:#1d4ed8}table{border-collapse:collapse;font-size:13px}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:right}td:first-child,th:first-child{text-align:left}.guide{min-width:720px}.guide th,.guide td{text-align:left;vertical-align:top;line-height:1.65}.guide th{min-width:150px}.guide td{width:40%}.scroll,.plot{overflow-x:auto}.plot svg{min-width:950px;width:100%}figure{margin:24px 0}figcaption{font-weight:600;margin-bottom:12px}select{font:inherit;padding:8px;max-width:100%}[hidden]{display:none}@media(max-width:650px){.guide,.guide tbody,.guide tr,.guide th,.guide td{display:block;min-width:0;width:auto}.guide thead{display:none}.guide tr{padding:12px 0;border-bottom:1px solid #ddd}.guide th,.guide td{border:0;padding:4px 0}.guide td{font-size:15px}.guide td:nth-child(2)::before{content:"Definition: ";font-weight:600}.guide td:nth-child(3)::before{content:"How to read it: ";font-weight:600}}</style><h1>Rust cell workload pilot</h1><p>Campaign seed: ${manifest.seed}. Passed: ${rows.filter((r) => r.passed).length}/${rows.length}. Timeouts: ${rows.filter((r) => r.timedOut).length}.</p><p>Compare Python standard library and Rust implementations of the same fixed algorithms. Times are in ms; lower is faster. This offline pilot is descriptive, without formal confidence intervals or an instrumentation-overhead audit.</p><nav aria-label="Report navigation"><a href="#charts">Compilation-excluded charts</a><a href="#conditions">All conditions</a><a href="#columns">13 column definitions</a><a href="#cache">Cold and warm</a></nav><section id="charts"><h2>Timing comparisons</h2><p><label for="chart-metric">Timing boundary: </label><select id="chart-metric">${metrics.map((m) => `<option value="${m.key}">${escapeHtml(m.label)}</option>`).join("")}</select></p><p>Each timing boundary has three scale charts: N01/N03/N04. Charts select one measured cell and binary/PRNG inputs; other conditions remain in the full table. Each chart has an independent linear scale, so bar lengths cannot be compared across charts. n is the valid successful sample count for that metric.</p><p>For each run, use its shared collector clock to merge Cargo/AOT command intervals, clip to the selected period and deduct once, then take the median across runs. Do not deduct nested cell.compile/cell.aot_compile phases again or subtract phase medians. Incomplete capture or missing clocks yield unavailable. This adjusts observed time arithmetically; it is not a run without compilation or an artifact-cache measurement.</p>${plots}</section><section id="conditions"><h2>All conditions</h2><p>Roundtrip/validated total in this table include Cargo/AOT. Select the charts above for compilation-excluded results.</p>${example}<div class="scroll"><table id="condition-table"><thead><tr><th>Condition</th><th>Work</th><th>Variant</th><th>Passed / planned</th><th>Failed / missing</th><th>Timeouts</th><th>Roundtrip<br>(includes Cargo/AOT)</th><th>Runtime execution<br>(excludes Cargo/AOT)</th><th>Compute<br>(excludes Cargo/AOT)</th><th>Cargo</th><th>AOT</th><th>Snapshot</th><th>Validated total<br>(includes Cargo/AOT)</th></tr></thead><tbody>${cells}</tbody></table></div></section>${guide}${warm}<script>const picker=document.getElementById("chart-metric");picker.addEventListener("change",()=>{for(const section of document.querySelectorAll("[data-metric]"))section.hidden=section.dataset.metric!==picker.value;});</script></html>`,
	);
}
