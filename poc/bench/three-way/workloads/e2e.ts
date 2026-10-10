import { join } from "node:path";
import type { Case } from "../types.js";
import { type WorkloadOptions, type WorkloadSpec, workloadCases } from "./cases.js";
import { verifyFixtureInputs, verifyWorkload } from "./fixtures.js";

const graph = `graph.bin contains little-endian u32 values: node count, edge count, query count; then edge pairs (depender, dependency); then query root IDs. Build reverse dependency adjacency once, then run a separate breadth-first traversal for EVERY query. Include the root, handle cycles and repeated edges, and mark each reachable node once per query. Output one bitmap per query in original order, concatenated with no header: ceil(nodes/8) bytes per bitmap, node n at byte n//8, bit n%8. Unused high bits must be zero. Do not replace the required traversals with cached answers or component-level shortcuts.`;
const events = `Process events-{batch}.bin in file order, streaming bounded chunks rather than loading the entire event file. Each 32-byte record has little-endian timestamp u64 at offset 0, key u32 at 8, sequence u32 at 12, signed amount i64 at 16, kind u8 at 24; offsets 25..31 are padding. JSONL mode instead has one [timestamp,key,sequence,amount,kind] array per line. Maintain independent state per key, initially open=false, since=0, pending=0, last sequence=-1, and all counters zero. For each record: (1) if sequence <= last sequence, increment duplicate and skip EVERYTHING else; otherwise update last sequence. (2) If open and timestamp-since > 30000, increment timeout, close and clear pending; retain since. (3) kind 1 START is valid only when closed: open, set since=timestamp, clear pending. Kind 2 CHARGE is valid only when open and amount>=0: add amount to pending. Kind 3 COMMIT is valid only when open: increment completed, add pending to total, close and clear pending. Kind 4 CANCEL is valid only when open: increment cancelled, close and clear pending. Every other case increments invalid without changing other state. Retain state between batches. Output JSON with one array per key in ascending key order: [open_as_0_or_1,since,pending,last_sequence,duplicate,timeout,invalid,completed,cancelled,total].`;
const simulation = `seeds-{batch}.bin contains little-endian u32 initial seeds, one per trajectory. For EVERY trajectory independently, initialize q=completed=expired=rejected=0 and x=seed. For exactly workload.json.steps iterations update x=(1664525*x+1013904223) modulo 2^32, then kind=x>>30. In simulationMode=events use the corresponding byte in simulation-events-{batch}.bin as kind instead. Kinds 0 and 1: if q==64 increment rejected, otherwise increment q. Kind 2: if q>0 decrement q and increment completed. Kind 3: if q>0 decrement q and increment expired. Output [q,completed,expired,rejected] as four little-endian u32 per trajectory in seed order, concatenated with no header. Perform all trajectory steps; do not skip work using cached answers or an analytical substitute.`;

export function workloadTask(spec: WorkloadSpec, batch: number): string {
	const instructions = spec.kind === "graph" ? graph : spec.kind === "events" ? events : simulation;
	return `Implement and execute the ${spec.kind} workload yourself. Read workload.json for dimensions and settings; the input files are already present. No solution source or expected output is supplied.
${instructions}
This turn processes batch ${batch} of ${spec.batches}. For graph, use query indices floor(queries*${batch}/${spec.batches}) through floor(queries*${batch + 1}/${spec.batches}) exclusive; for other workloads use this batch's input file. Write result-${batch}.${spec.kind === "events" ? "json" : "bin"}. Later turns may reuse your helper code and preprocessing, but each batch must perform its actual work. Inputs are immutable. Stay inside the project directory, do not inspect parent directories, benchmark harness code, or expected outputs. Use only the Python standard library or the installed Rust cell prelude and standard library; do not use NumPy, other numeric libraries, native extensions, shell commands, or external programs. Keep console output small. Fix any cell compilation or execution errors before finishing. The independent host checker will compare every output element after the final turn.`;
}

export function workloadE2eCases(root: string, selection: string, options: WorkloadOptions = {}): Case[] {
	if (options.cache?.some((cache) => cache !== "cold"))
		throw new Error("E2E workloads currently require cold workspaces; model-generated warmup policy is not defined");
	const items = workloadCases(root, "workloads", { ...options, cache: ["cold"] });
	const result = items.map((item): Case => {
		const spec = item.workload!;
		const { runtime: _runtime, ...base } = item;
		return {
			...base,
			id: `E-${item.id}`,
			lane: "end-to-end",
			turns: Array.from({ length: spec.batches }, (_, batch) => workloadTask(spec, batch)),
			taskBudgetMs: Math.max(600000, spec.batches * 300000),
			cacheCondition: "cold-workspace-template-installed-model-generated",
			check: { kind: "workload" },
			parameters: { ...item.parameters, algorithmTier: "model-generated-required-work", solutionProvided: false },
		};
	});
	const ids = selection.split(",");
	const selected = result.filter(
		(item) => selection === "workloads-e2e" || ids.some((id) => item.id === id || item.id.startsWith(`${id}-`)),
	);
	if (
		!selected.length ||
		(selection !== "workloads-e2e" &&
			ids.some((id) => !selected.some((item) => item.id === id || item.id.startsWith(`${id}-`))))
	)
		throw new Error("Unknown E2E workload selection");
	return selected;
}

export function checkWorkloadTask(project: string, oracle: string, spec: WorkloadSpec) {
	const outputs = Array.from({ length: spec.batches }, (_, batch) => ({
		batch,
		...verifyWorkload(project, oracle, spec, batch),
	}));
	const inputsUnchanged = verifyFixtureInputs(project, oracle);
	return { pass: inputsUnchanged && outputs.every((output) => output.pass), inputsUnchanged, outputs };
}

export const workloadOracleDirectory = (directory: string) => join(directory, "oracle");
