import type { WorkloadSpec } from "./cases.js";

export function workloadTaskGuide(spec: WorkloadSpec) {
	const n = (value: number) => value.toLocaleString("en-US");
	const common = { kind: spec.kind, scale: spec.scale, batches: spec.batches };
	if (spec.kind === "graph")
		return {
			...common,
			title: "N01 graph: dependency change impact",
			purpose:
				"Find every component that directly or indirectly depends on a changed component and needs to be processed again.",
			work: `${n(spec.nodes)} nodes, ${n(spec.edges)} dependency edges, ${n(spec.queries)} independent queries.`,
			input: "graph.bin contains node, edge and query counts, (depender, dependency) pairs, and query roots, all encoded as little-endian u32 values.",
			task: "Build reverse dependency adjacency once, then run a separate BFS for every root. Include the root, handle cycles and repeated edges, and visit each reachable node once per query. Cached answers or component-level shortcuts cannot replace the required traversals.",
			output:
				"Concatenate one affected-node bitmap per query in query order. The checker compares every bit, including unused trailing bits.",
			focus: "Graph traversal, index access, integer conditions and bitmap updates.",
		};
	if (spec.kind === "events")
		return {
			...common,
			title: "N03 events: streaming transaction state machine",
			purpose:
				"Process transaction events for multiple accounts or sessions, maintain independent state, and reject duplicate or invalid events.",
			work: `${n(spec.events)} events, ${n(spec.keys)} independent keys; ${spec.format === "binary" ? `32 bytes per record, ${n(spec.events * 32)} input bytes.` : "JSONL input."}`,
			input: "Each record contains timestamp, key, sequence, amount and kind. Read in file order using bounded chunks rather than loading the entire event file.",
			task: "Maintain START/CHARGE/COMMIT/CANCEL state per key. Deduplicate by sequence first, process timeouts beyond 30,000 time units next, then apply the event. Negative charges and illegal transitions count as invalid. Retain state across batches.",
			output:
				"Emit final state, pending amount, last sequence, and duplicate/timeout/invalid/completed/cancelled/total fields in key order. The checker compares every field.",
			focus: "Streaming file I/O and decoding, conditional branches, and repeated updates to a small state table.",
		};
	return {
		...common,
		title: "N04 simulation: integer queue trajectories",
		purpose:
			"Simulate many independent work queues with capacity 64 and count completed, expired and capacity-rejected work.",
		work: `${n(spec.trajectories)} trajectories × ${n(spec.steps)} steps, ${n(spec.trajectories * spec.steps)} state updates in total.`,
		input: `Initial u32 seeds are stored in seeds-{batch}.bin; ${spec.simulationMode === "prng" ? "the program generates events with its PRNG." : "event kinds are read from simulation-events-{batch}.bin."}`,
		task: "At each step, perform the u32 PRNG multiply/add modulo 2^32, then enqueue, complete or expire work. Record rejection when the queue is full. Execute every step of every trajectory; cached answers or formulas cannot skip the loops.",
		output:
			"Emit [final queue length, completed, expired, rejected] as four little-endian u32 values per trajectory. The checker compares every value in original seed order.",
		focus: "Large volumes of u32 arithmetic, wrapping semantics and loops with frequent branches.",
	};
}

export const columnGuide = [
	{
		label: "Condition",
		meaning:
			"Complete condition ID: case, scale, cell batches, workspace state, algorithm variant, input format and simulation mode.",
		reading:
			"For example, N04-simulation-large-b1-cold-reference-binary-prng means large integer simulation, one measured cell, a fresh workspace, the fixed algorithm, binary seeds and guest-generated PRNG events. Compare variants only under identical conditions; do not pool different conditions.",
	},
	{
		label: "Work",
		meaning:
			"Total work per run, not per cell. N01 lists nodes/edges/queries; N03 lists events/active keys; N04 lists trajectories × steps.",
		reading:
			"b4 partitions the same total work into four cells; it does not multiply work by four. Confirm equal work before comparing time. Guest counters and the full-output oracle verify the work actually completed.",
	},
	{
		label: "Variant",
		meaning:
			"Host and cell-runtime combination: prime-ts = TypeScript host + Python cell; prime-rust = Rust host + Python cell; wasmedge = TypeScript host + Rust/Wasm interpreter; wasmedge-aot = the same host + Rust/Wasm AOT.",
		reading:
			"The Rust in prime-rust describes the host, not the cell. The main runtime comparison is prime-ts versus the two wasmedge variants; prime-rust also reflects host differences. Both Python variants share source, as do both Wasm variants.",
	},
	{
		label: "Passed / planned",
		meaning:
			"Runs passing full acceptance / runs scheduled in the manifest. Each run must finish normally, have successful and fully measured cells, pass complete per-batch output and input-integrity checks, and validate warmup outputs too.",
		reading:
			"5/5 means all five paired repetitions passed. Timing columns take per-run totals first, then the median of successful runs with valid measurements. Charts also show the metric's sample count n. Successful latency does not establish completion rate.",
	},
	{
		label: "Failed / missing",
		meaning:
			"All scheduled runs that did not pass: checker/runtime failures, timeouts, infrastructure errors, and unexecuted or unrecorded slots. Equals planned minus passed.",
		reading:
			"This combines failures and missing records; raw results/traces retain the detailed classification. Unsuccessful runs have no successful latency. Do not fill them with zero or discard them to claim a win.",
	},
	{
		label: "Timeouts",
		meaning: "Number of runs with recorded timedOut=true.",
		reading:
			"A subset of Failed / missing; do not add it again. Zero means no recorded timeout, not that missing slots ran or all runs passed.",
	},
	{
		label: "Roundtrip (includes Cargo/AOT)",
		meaning:
			"Wall time from measured cell submission to the complete result. Includes adapter/host communication, admission/queueing, source/policy processing, Cargo, AOT, runtime execution, snapshots and cleanup. Excludes initial runtime startup, warmups and the host oracle after cell return.",
		reading:
			"Sum measured cell roundtrips within each run, then take the median across successful runs. This is actual cell submission latency with Rust compilation retained. b4 reports the sum of four calls, not an average cell.",
	},
	{
		label: "Runtime execution (excludes Cargo/AOT)",
		meaning:
			"Direct runtime cell.execution/cell.python_execute measurements. Excludes Cargo, AOT, runtime initialization, host admission and snapshots. Rust still includes a new process/VM, input reads, guest work, bridge waits and output collection; Python uses a resident runtime.",
		reading:
			"Compares work inside the execution boundary. This is neither all remaining roundtrip cost after subtracting compilation nor pure CPU time. Python and Rust process-lifecycle differences remain.",
	},
	{
		label: "Compute (excludes Cargo/AOT)",
		meaning:
			"Algorithm phase measured by the guest's monotonic timer. N01 covers traversal and bitmap creation, excluding index build/load and output writes. N04 covers PRNG/state updates and result-buffer creation, excluding input reads and output writes. N03 combines streaming decode, I/O and transitions.",
		reading:
			"Explains algorithm cost and does not establish product speed on its own. N03 is not pure computation/CPU. Guest durations use local clocks and cannot be assembled into the collector timeline.",
	},
	{
		label: "Cargo",
		meaning:
			"Sum of runtime-reported Rust-to-Wasm Cargo build phases in measured cells, then median across runs. Uses release/offline builds.",
		reading:
			"Not applicable to Python, shown as —. This is not all Cargo commands in the run and excludes warmup/initialization Cargo. Compilation-excluded charts instead use calibrated command wall intervals, not subtraction of this column's median.",
	},
	{
		label: "AOT",
		meaning:
			"Sum of runtime-reported host AOT phases in measured AOT cells, then median. Includes trusted Wasm-to-native compilation and associated phase work.",
		reading:
			"Applies only to wasmedge-aot; Python and the interpreter show —. Every AOT cell recompiles, including in warm workspaces, with no artifact cache. Deduction charts use aot.command intervals.",
	},
	{
		label: "Snapshot",
		meaning: "Sum of runtime workspace/Git snapshot phases after measured Rust cells, then median across runs.",
		reading:
			"This experiment has no equivalent Python runtime snapshot phase, so Python shows —. This does not include all state/blob I/O: guest serialization and blob I/O remain in runtime execution. Compilation-excluded roundtrip retains snapshots.",
	},
	{
		label: "Validated total (includes Cargo/AOT)",
		meaning:
			"Wall time from before runtime startup to run acceptance completion. Includes initialization, warmups, measured cells, all Cargo/AOT, per-batch host oracles, input-integrity verification, runtime disposal and other host work during that period.",
		reading:
			"Fixture/oracle generation precedes this boundary and is recorded separately as task.fixture_generate. This is the total cost of a validated result. Warm validated total still includes warming costs and is not pure hot-cell latency.",
	},
];

export const readingRules = [
	"Times are in ms; lower is faster. Sum measured cells within each run, then take the median across repetitions. Values are not averages per cell.",
	"— means not applicable, no valid samples, or missing measurement; it is not zero. Raw records retain missing reasons and failures. Chart n counts successful runs with valid data for that metric.",
	"Roundtrip contains runtime execution, which contains compute. Cargo, AOT and snapshot are also parts of roundtrip. These columns are not independent additive costs; phase medians cannot reconstruct the median total.",
	"Compilation-excluded charts are diagnostic. Compilation-inclusive roundtrip/validated total retain actual cost. Five paired repetitions are descriptive; confidence intervals and instrumentation overhead remain unaudited.",
];

export const cacheGuide = [
	"cold: each run starts a new workspace/runtime with no warmup. Toolchain, prepared template/vendor and OS caches remain, so this is not a machine-wide or toolchain cold start.",
	"warm (hot): run at least two complete workload cycles in the same workspace/runtime before measuring the last cycle. Validate every cycle. Warmups are excluded from measured cell/phase metrics but included in validated total.",
	"Warm conditions may reduce Cargo incremental-build, filesystem-cache or Python post-initialization costs. Rust still starts a new process/VM per cell, and AOT recompiles each time. There is no resident VM or AOT artifact reuse.",
	"N01's index and N03's event state reset at batch 0 of each cycle and persist only across later batches in that cycle. Warm does not skip graph index construction, reuse previous answers or reduce measured work.",
	"Compilation-excluded charts already remove faster compilation's benefit. Any remaining warm speedup must be measured in execution, I/O, snapshots and other phases; cold results cannot predict hot speedup.",
];
