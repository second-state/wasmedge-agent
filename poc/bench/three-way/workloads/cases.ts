import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Case, RuntimeStep } from "../types.js";

export type WorkloadKind = "graph" | "events" | "simulation";
export type WorkloadScale = "small" | "medium" | "large";
export interface WorkloadSpec {
	version: 1;
	kind: WorkloadKind;
	scale: WorkloadScale;
	batches: number;
	cache: "cold" | "warm";
	warmups: number;
	// Keep the historical value readable so old control records can be excluded.
	implementation: "reference" | "numpy";
	format: "binary" | "jsonl";
	simulationMode: "prng" | "events";
	nodes: number;
	edges: number;
	queries: number;
	events: number;
	keys: number;
	trajectories: number;
	steps: number;
}
export interface WorkloadOptions {
	scales?: WorkloadScale[];
	batches?: number[];
	cache?: ("cold" | "warm")[];
	warmups?: number;
	formats?: ("binary" | "jsonl")[];
	simulationModes?: ("prng" | "events")[];
}

export function workloadCases(root: string, selection: string, options: WorkloadOptions = {}): Case[] {
	const scales = options.scales ?? ["small", "medium", "large"];
	const batches = options.batches ?? [1];
	const caches = options.cache ?? ["cold"];
	const warmups = options.warmups ?? 2;
	if (!scales.length || scales.some((s) => !["small", "medium", "large"].includes(s)))
		throw new Error("Workload scales must be small,medium,large");
	if (!batches.length || batches.some((n) => ![1, 4, 16, 64].includes(n)))
		throw new Error("Workload batches must be 1,4,16,64");
	if (!caches.length || caches.some((s) => !["cold", "warm"].includes(s)))
		throw new Error("Workload cache must be cold,warm");
	if (!Number.isSafeInteger(warmups) || warmups < 0 || warmups > 10 || (caches.includes("warm") && warmups < 2))
		throw new Error("Warm workloads require 2..10 warmups");
	const formats = options.formats ?? ["binary"];
	const modes = options.simulationModes ?? ["prng"];
	if (!formats.length || formats.some((s) => !["binary", "jsonl"].includes(s)))
		throw new Error("Invalid event format");
	if (!modes.length || modes.some((s) => !["prng", "events"].includes(s))) throw new Error("Invalid simulation mode");
	const python = readFileSync(join(root, "poc/bench/three-way/workloads/reference.py"), "utf8");
	const result: Case[] = [];
	for (const kind of ["graph", "events", "simulation"] as const)
		for (const scale of scales)
			for (const batchCount of batches)
				for (const cache of caches)
					for (const format of kind === "events" ? formats : (["binary"] as const))
						for (const simulationMode of kind === "simulation" ? modes : (["prng"] as const)) {
							const index = ["small", "medium", "large"].indexOf(scale);
							const spec: WorkloadSpec = {
								version: 1,
								kind,
								scale,
								batches: batchCount,
								cache,
								warmups: cache === "warm" ? warmups : 0,
								implementation: "reference",
								format,
								simulationMode,
								nodes: [1000, 10000, 100000][index],
								edges: [4000, 40000, 400000][index],
								queries: [64, 128, 256][index],
								events: [100000, 1000000, 10000000][index],
								keys: [10, 100, 1000][index],
								trajectories: [10000, 100000, 1000000][index],
								steps: 256,
							};
							const family =
								kind === "graph" ? "N01-graph" : kind === "events" ? "N03-events" : "N04-simulation";
							const id = `${family}-${scale}-b${batchCount}-${cache}-reference-${format}-${simulationMode}`;
							const steps = (code: string): RuntimeStep[] =>
								Array.from({ length: spec.warmups + 1 }, (_, cycle) =>
									Array.from({ length: batchCount }, (_, batch) => ({
										op: "execute" as const,
										code,
										expectedStatus: ["ok"],
										stdoutIncludes: "BENCH_OK",
										workloadBatch: batch,
										warmup: cycle < spec.warmups,
									})),
								).flat();
							result.push({
								id,
								lane: "runtime",
								scale,
								cacheCondition: `${cache}-workspace-template-installed`,
								turns: [],
								taskBudgetMs: Math.max(300000, batchCount * (spec.warmups + 1) * 120000),
								fixture: {},
								tools: "runtime-only",
								check: { kind: "marker", value: "BENCH_OK" },
								parameters: {
									workload: spec,
									algorithmTier: "fixed-algorithm",
									fixtureSeedPolicy: "campaign-seed-plus-repetition-v1",
									numericLibraryThreads: 1,
								},
								workload: spec,
								runtime: {
									"prime-ts": steps(python),
									"prime-rust": steps(python),
									wasmedge: steps(
										readFileSync(join(root, `poc/bench/three-way/workloads/${kind}.rs`), "utf8"),
									),
									"wasmedge-aot": steps(
										readFileSync(join(root, `poc/bench/three-way/workloads/${kind}.rs`), "utf8"),
									),
								},
							});
						}
	const ids = selection.split(",");
	const selected = result.filter(
		(c) => selection === "workloads" || ids.some((id) => c.id === id || c.id.startsWith(`${id}-`)),
	);
	if (
		!selected.length ||
		(selection !== "workloads" && ids.some((id) => !selected.some((c) => c.id === id || c.id.startsWith(`${id}-`))))
	)
		throw new Error("Unknown workload selection");
	if (new Set(selected.map((c) => c.id)).size !== selected.length) throw new Error("Duplicate workload condition");
	return selected;
}

export function batchRange(total: number, batches: number, batch: number): [number, number] {
	return [Math.floor((total * batch) / batches), Math.floor((total * (batch + 1)) / batches)];
}
