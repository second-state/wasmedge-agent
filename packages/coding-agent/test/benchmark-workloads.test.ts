import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cases } from "../../../poc/bench/three-way/cases.js";
import { subtractCompilationAndModel } from "../../../poc/bench/three-way/compilation.js";
import { writeJson } from "../../../poc/bench/three-way/files.js";
import type { Prepared } from "../../../poc/bench/three-way/prepare.js";
import { analyze } from "../../../poc/bench/three-way/report.js";
import { randomizedSlots } from "../../../poc/bench/three-way/runner.js";
import { directRuntime, RuntimeDeadlineError } from "../../../poc/bench/three-way/runtime.js";
import { Trace } from "../../../poc/bench/three-way/trace.js";
import type { Manifest, RunResult, RunSlot } from "../../../poc/bench/three-way/types.js";
import { batchRange, type WorkloadSpec, workloadCases } from "../../../poc/bench/three-way/workloads/cases.js";
import { checkWorkloadTask } from "../../../poc/bench/three-way/workloads/e2e.js";
import { workloadE2eReport } from "../../../poc/bench/three-way/workloads/e2e-report.js";
import {
	applyEvent,
	emptyEventState,
	generateFixture,
	graphOracle,
	nextRandom,
	simulationOracle,
	verifyFixtureInputs,
	verifyWorkload,
} from "../../../poc/bench/three-way/workloads/fixtures.js";
import { workloadTaskGuide } from "../../../poc/bench/three-way/workloads/guide.js";
import { workloadReport, workloadRow } from "../../../poc/bench/three-way/workloads/report.js";

const root = resolve("../..");
const directories: string[] = [];
const temporary = () => {
	const d = mkdtempSync(join(tmpdir(), "wa-workloads-test-"));
	directories.push(d);
	return d;
};
afterEach(() => {
	for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

function spec(kind: WorkloadSpec["kind"], overrides: Partial<WorkloadSpec> = {}): WorkloadSpec {
	return {
		...workloadCases(root, "workloads", { scales: ["small"] }).find((c) => c.workload?.kind === kind)!.workload!,
		nodes: 13,
		edges: 70,
		queries: 9,
		events: 101,
		keys: 3,
		trajectories: 31,
		steps: 16,
		...overrides,
	};
}

describe("workload benchmark contracts", () => {
	it("plans real model tasks without embedding a reference solution and rejects undefined warm policy", () => {
		const items = cases(root, "workloads-e2e", { scales: ["small"], batches: [1, 4] });
		expect(items).toHaveLength(6);
		for (const item of items) {
			expect(item.lane).toBe("end-to-end");
			expect(item.runtime).toBeUndefined();
			expect(item.turns).toHaveLength(item.workload!.batches);
			expect(item.parameters.solutionProvided).toBe(false);
			expect(item.turns[0]).toContain("do not use NumPy");
		}
		const slots = randomizedSlots(items, ["prime-ts", "wasmedge-aot"], 2, 42, "test-opus");
		expect(slots.every((slot) => slot.modelId === "test-opus")).toBe(true);
		expect(cases(root, "E-N03-events", { scales: ["small"] })).toHaveLength(1);
		expect(() => cases(root, "workloads-e2e", { cache: ["warm"] })).toThrow("warmup policy");
	});
	it("checks every E2E batch and input integrity without relying on an assistant marker", () => {
		const d = temporary(),
			project = join(d, "project"),
			oracle = join(d, "oracle"),
			cfg = spec("simulation", { batches: 4 });
		generateFixture(project, oracle, cfg, 42);
		for (let batch = 0; batch < cfg.batches; batch++)
			copyFileSync(join(oracle, `result-${batch}.bin`), join(project, `result-${batch}.bin`));
		expect(checkWorkloadTask(project, oracle, cfg).pass).toBe(true);
		writeFileSync(join(project, "result-2.bin"), "corrupt");
		expect(checkWorkloadTask(project, oracle, cfg).pass).toBe(false);
		copyFileSync(join(oracle, "result-2.bin"), join(project, "result-2.bin"));
		writeFileSync(join(project, "seeds-0.bin"), "corrupt");
		expect(checkWorkloadTask(project, oracle, cfg)).toMatchObject({ pass: false, inputsUnchanged: false });
	});
	it("retains all E2E request evidence, excludes failed timings and preserves missing usage", () => {
		const item = cases(root, "E-N01-graph", { scales: ["small"] })[0];
		const slot: RunSlot = {
			runId: "e2e",
			caseId: item.id,
			variantId: "prime-ts",
			repetition: 1,
			caseHash: "test",
			modelId: "test-opus",
		};
		const run: RunResult = {
			...slot,
			applicable: true,
			status: "completed",
			startedAt: null,
			agentElapsedMs: 100,
			userElapsedMs: 110,
			validatedElapsedMs: 120,
			checkPass: true,
			timedOut: false,
			error: null,
			turnExitCodes: [0],
			requestCount: 2,
			sessionFile: null,
			peakSampledTreeRssBytes: null,
			cargoCapture: {
				version: 1,
				complete: true,
				clockVerified: true,
				startedCommands: 0,
				completedCommands: 0,
				errors: [],
				method: "cargo-path-and-runtime-override",
			},
		};
		const directory = temporary(),
			trace = new Trace(directory, slot);
		const span = (name: string, start: number, end: number, attributes: Record<string, unknown> = {}) =>
			trace.add({
				name,
				startMonoNs: String(start * 1e6),
				endMonoNs: String(end * 1e6),
				durationMs: end - start,
				measurementState: "measured",
				outcome: "ok",
				attributes,
			});
		span("task.agent_elapsed", 0, 100);
		span("run.user_elapsed", 0, 110);
		span("run.validated_elapsed", 0, 120);
		span("llm.request", 0, 20, { requestId: "one", timingBoundary: "gateway-receipt" });
		span("llm.request", 30, 60, { requestId: "two", timingBoundary: "gateway-receipt" });
		const failed = {
			...run,
			runId: "failed",
			repetition: 2,
			checkPass: false,
			validatedElapsedMs: 1000,
			requestCount: 1,
		};
		const manifest: Manifest = {
			version: 1,
			createdAt: "test",
			seed: 42,
			root: directory,
			provider: null,
			variants: [
				{
					id: "prime-ts",
					baseRevision: "test",
					sourceRoot: root,
					command: "node",
					args: [],
					inputsHash: "test",
					launcherHash: "test",
				},
			],
			cases: [item],
			runs: [slot, failed, { ...slot, runId: "missing", repetition: 3 }],
			requestLimitPerRun: 64,
			collectorSourceHash: "test",
			profileCommands: false,
		};
		workloadE2eReport(directory, manifest, [run, failed], trace.spans, [
			{
				runId: "e2e",
				upstreamStatus: 200,
				responseBytes: 100,
				responseModelIds: ["test-opus"],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			},
			{ runId: "e2e", upstreamStatus: 200, responseBytes: 200, responseModelIds: ["test-opus"], usage: null },
			{ runId: "failed", upstreamStatus: 500, responseBytes: 0, usage: null },
		]);
		const report = JSON.parse(readFileSync(join(directory, "workloads-e2e.json"), "utf8"));
		expect(report).toMatchObject({
			planned: 3,
			passed: 1,
			requests: 3,
			upstream200Requests: 2,
			rankingAllowed: false,
		});
		expect(report.rows[0]).toMatchObject({
			llmMs: 50,
			validatedWithoutCompilationAndModelMs: 70,
			inputTokens: null,
			outputTokens: null,
			responseModelIds: ["test-opus"],
		});
		expect(report.groups[0]).toMatchObject({
			planned: 3,
			passed: 1,
			failedOrMissing: 2,
			validatedMs: 120,
			requestsAllRuns: 3,
			validatedWithoutCompilationAndModelMs: 70,
			metricSamples: { validatedWithoutCompilationAndModelMs: 1 },
		});
		expect(report.rows[1].validatedWithoutCompilationAndModelMs).toBeNull();
		expect(report.rows[2].validatedWithoutCompilationAndModelMs).toBeNull();
		expect(report.tasks[0]).toMatchObject({
			kind: "graph",
			scale: "small",
			work: "1,000 nodes, 4,000 dependency edges, 64 independent queries.",
		});
		const html = readFileSync(join(directory, "workloads-e2e.html"), "utf8");
		expect(html).toContain("includes model");
		expect(html).toContain("E2E minus Cargo/AOT (excludes model)");
		expect(html.match(/<figure /g)).toHaveLength(5);
		expect(html).toContain('lang="en"');
		expect(html).not.toMatch(/\p{Script=Han}/u);
		expect(html).toContain("dependency change impact");
		expect(html).toContain("1,000 nodes");
	});
	it("deducts the clipped union of model and compiler intervals once and requires complete clocks and identities", () => {
		const run: RunResult = {
			runId: "union",
			caseId: "E-N04",
			variantId: "wasmedge-aot",
			repetition: 1,
			caseHash: "test",
			modelId: "test",
			applicable: true,
			status: "completed",
			startedAt: null,
			agentElapsedMs: 100,
			userElapsedMs: 100,
			validatedElapsedMs: 100,
			checkPass: true,
			timedOut: false,
			error: null,
			turnExitCodes: [0],
			requestCount: 2,
			sessionFile: null,
			peakSampledTreeRssBytes: null,
			cargoCapture: {
				version: 1,
				complete: true,
				clockVerified: true,
				startedCommands: 2,
				completedCommands: 2,
				errors: [],
				method: "cargo-path-and-runtime-override",
			},
			aotCapture: {
				version: 1,
				complete: true,
				clockVerified: true,
				startedCommands: 1,
				completedCommands: 1,
				errors: [],
				method: "aot-runtime-override",
			},
		};
		const trace = new Trace(temporary(), run);
		const span = (name: string, start: number, end: number, attributes: Record<string, unknown> = {}) =>
			trace.add({
				name,
				startMonoNs: String(start * 1e6),
				endMonoNs: String(end * 1e6),
				durationMs: end - start,
				measurementState: "measured",
				outcome: "ok",
				attributes,
			});
		for (const name of ["task.agent_elapsed", "run.user_elapsed", "run.validated_elapsed"]) span(name, 10, 110);
		span("cargo.command", 0, 30, { commandId: "cargo-1", provenance: "cargo-wrapper-command-wall" });
		span("cargo.command", 90, 120, { commandId: "cargo-2", provenance: "cargo-wrapper-command-wall" });
		span("aot.command", 25, 45, { commandId: "aot", provenance: "aot-wrapper-command-wall" });
		span("llm.request", 5, 60, { requestId: "request-1", timingBoundary: "gateway-receipt" });
		const last = span("llm.request", 50, 80, { requestId: "request-2", timingBoundary: "gateway-receipt" });
		last.outcome = "error";
		expect(subtractCompilationAndModel(run, trace.spans)).toMatchObject({
			validatedWithoutCompilationAndModelMs: 10,
			validatedModelMs: 70,
			validatedCompilerAndModelMs: 90,
			validatedCompilerModelOverlapMs: 35,
		});
		const withoutCompiler = trace.spans.filter((s) => !["cargo.command", "aot.command"].includes(s.name));
		expect(
			subtractCompilationAndModel(
				{
					...run,
					variantId: "prime-ts",
					aotCapture: undefined,
					cargoCapture: { ...run.cargoCapture!, startedCommands: 0, completedCommands: 0 },
				},
				withoutCompiler,
			).validatedWithoutCompilationAndModelMs,
		).toBe(30);
		expect(
			subtractCompilationAndModel(
				run,
				trace.spans.filter((s) => s !== last),
			),
		).toMatchObject({ validatedWithoutCompilationAndModelMs: null, reason: "missing-model-request-intervals" });
		last.clockId = "other";
		expect(subtractCompilationAndModel(run, trace.spans).validatedWithoutCompilationAndModelMs).toBeNull();
		last.clockId = trace.clockId;
		last.requestId = "request-1";
		expect(subtractCompilationAndModel(run, trace.spans).validatedWithoutCompilationAndModelMs).toBeNull();
		last.requestId = "request-2";
		expect(
			subtractCompilationAndModel({ ...run, aotCapture: undefined }, trace.spans)
				.validatedWithoutCompilationAndModelMs,
		).toBeNull();
		expect(
			subtractCompilationAndModel({ ...run, checkPass: false }, trace.spans).validatedWithoutCompilationAndModelMs,
		).toBeNull();
	});
	it("explains the actual dimensions, required work and checked outputs for all three workloads", () => {
		const guides = workloadCases(root, "workloads", { scales: ["large"] }).map((item) =>
			workloadTaskGuide(item.workload!),
		);
		expect(guides.map((guide) => guide.work)).toEqual([
			"100,000 nodes, 400,000 dependency edges, 256 independent queries.",
			"10,000,000 events, 1,000 independent keys; 32 bytes per record, 320,000,000 input bytes.",
			"1,000,000 trajectories × 256 steps, 256,000,000 state updates in total.",
		]);
		expect(guides[0].task).toContain("BFS");
		expect(guides[1].task).toContain("Deduplicate by sequence");
		expect(guides[2].task).toContain("modulo 2^32");
		for (const guide of guides) expect(guide.output).toContain("checker");
	});
	it("keeps existing suites separate and produces identical Python and Wasm reference pairs", () => {
		expect(cases(root, "runtime")).toHaveLength(16);
		const items = cases(root, "workloads", {
			scales: ["small"],
			batches: [1, 4],
			cache: ["cold", "warm"],
		});
		expect(items).toHaveLength(12);
		for (const item of items) {
			expect(item.workload!.implementation).toBe("reference");
			expect(item.runtime!["prime-ts"]![0].code).not.toContain("import numpy");
			expect(item.runtime!["prime-ts"]).toEqual(item.runtime!["prime-rust"]);
			expect(item.runtime!.wasmedge).toEqual(item.runtime!["wasmedge-aot"]);
			expect(item.runtime!.wasmedge!.filter((s) => !s.warmup)).toHaveLength(item.workload!.batches);
		}
		const slots = randomizedSlots(items, ["prime-ts", "prime-rust", "wasmedge", "wasmedge-aot"], 2, 42, "none");
		expect(slots).toHaveLength(96);
		expect(slots.every((s) => s.modelId === "none-direct-runtime")).toBe(true);
	});
	it("rejects unsupported scales, duplicate conditions and insufficient warmups", () => {
		expect(() => workloadCases(root, "workloads", { batches: [2] })).toThrow();
		expect(() => workloadCases(root, "workloads", { cache: ["warm"], warmups: 1 })).toThrow();
		expect(() => workloadCases(root, "workloads", { scales: ["small", "small"] })).toThrow("Duplicate");
		expect(() => workloadCases(root, "N01-missing")).toThrow("Unknown");
	});
	it("partitions uneven work without duplication or omissions", () => {
		expect(Array.from({ length: 4 }, (_, i) => batchRange(9, 4, i))).toEqual([
			[0, 2],
			[2, 4],
			[4, 6],
			[6, 9],
		]);
	});
	it("checks reversed dependency direction, cycles, duplicate edges and isolated roots", () => {
		expect([
			...graphOracle(
				5,
				[
					[1, 0],
					[2, 1],
					[0, 2],
					[1, 0],
					[3, 3],
				],
				[0, 3, 4],
			),
		]).toEqual([7, 8, 16]);
	});
	it("matches exact PRNG recurrence at uint32 boundaries", () => {
		let x = 0;
		for (let i = 0; i < 100; i++) {
			const exact = Number((BigInt(x) * 1664525n + 1013904223n) % 4294967296n);
			x = nextRandom(x);
			expect(x).toBe(exact);
		}
		expect(nextRandom(0xffffffff)).toBe(Number((0xffffffffn * 1664525n + 1013904223n) % 4294967296n));
		expect(simulationOracle(0, 5, Uint8Array.from([0, 1, 2, 3, 2]))).toEqual([0, 1, 1, 0]);
		expect(simulationOracle(0, 70, new Uint8Array(70))).toEqual([64, 0, 0, 6]);
	});
	it("keeps timeout boundary exact and rejects duplicates before applying a transition", () => {
		const state = emptyEventState();
		applyEvent(state, { timestamp: 0, key: 0, seq: 1, amount: 0, kind: 1 });
		applyEvent(state, { timestamp: 30000, key: 0, seq: 2, amount: 42, kind: 2 });
		applyEvent(state, { timestamp: 30001, key: 0, seq: 2, amount: 0, kind: 3 });
		expect(state).toMatchObject({ open: true, pending: 42, duplicate: 1, timeout: 0 });
		applyEvent(state, { timestamp: 30001, key: 0, seq: 3, amount: 0, kind: 3 });
		expect(state).toMatchObject({ open: false, pending: 0, timeout: 1, invalid: 1, total: 0 });
	});
	it("does not commit cancelled or negative charges", () => {
		const state = emptyEventState();
		for (const [seq, kind, amount] of [
			[1, 1, 0],
			[2, 2, -1],
			[3, 2, 5],
			[4, 4, 0],
			[5, 1, 0],
			[6, 2, 7],
			[7, 3, 0],
		])
			applyEvent(state, { timestamp: seq, key: 0, seq, kind, amount });
		expect(state).toMatchObject({ total: 7, completed: 1, cancelled: 1, invalid: 1, open: false });
	});
	it.each(["graph", "events", "simulation"] as const)("keeps %s total work identical across batch counts", (kind) => {
		const a = temporary(),
			b = temporary(),
			one = spec(kind),
			many = spec(kind, { batches: 4 });
		const first = generateFixture(join(a, "project"), join(a, "oracle"), one, 42),
			second = generateFixture(join(b, "project"), join(b, "oracle"), many, 42);
		const expected = (d: string, paths: string[]) =>
			Buffer.concat(paths.map((p) => readFileSync(join(d, "oracle", p))));
		if (kind === "events") {
			expect(JSON.parse(readFileSync(join(a, "oracle", "result-0.json"), "utf8"))).toEqual(
				JSON.parse(readFileSync(join(b, "oracle", "result-3.json"), "utf8")),
			);
			expect(readFileSync(join(a, "project", "events-0.bin"))).toEqual(
				Buffer.concat(Array.from({ length: 4 }, (_, i) => readFileSync(join(b, "project", `events-${i}.bin`)))),
			);
		} else
			expect(
				expected(
					a,
					first.expected.map((e) => e.path),
				),
			).toEqual(
				expected(
					b,
					second.expected.map((e) => e.path),
				),
			);
	});
	it.each(["graph", "events", "simulation"] as const)(
		"validates Python %s output against the independent oracle across cells",
		(kind) => {
			const d = temporary(),
				cfg = spec(kind, { batches: 4 });
			generateFixture(join(d, "project"), join(d, "oracle"), cfg, 42);
			writeJson(join(d, "project", "workload.json"), { ...cfg, chunkBytes: 63 });
			const reference = join(root, "poc/bench/three-way/workloads/reference.py");
			execFileSync(
				"python3",
				[
					"-c",
					`from pathlib import Path\ncode=Path(${JSON.stringify(reference)}).read_text()\nfor i in range(4):\n Path('batch-index.txt').write_text(str(i))\n exec(code)\n`,
				],
				{ cwd: join(d, "project") },
			);
			for (let i = 0; i < 4; i++)
				expect(verifyWorkload(join(d, "project"), join(d, "oracle"), cfg, i).pass).toBe(true);
			const output = join(d, "project", `result-3.${kind === "events" ? "json" : "bin"}`);
			writeFileSync(output, kind === "events" ? "[]" : Buffer.alloc(1));
			expect(verifyWorkload(join(d, "project"), join(d, "oracle"), cfg, 3).pass).toBe(false);
		},
	);
	it("matches JSONL and binary event oracles and rejects truncated binary input", () => {
		const d = temporary(),
			cfg = spec("events", { format: "jsonl" });
		generateFixture(join(d, "project"), join(d, "oracle"), cfg, 42);
		writeFileSync(join(d, "project", "batch-index.txt"), "0");
		execFileSync("python3", [join(root, "poc/bench/three-way/workloads/reference.py")], { cwd: join(d, "project") });
		expect(verifyWorkload(join(d, "project"), join(d, "oracle"), cfg, 0).pass).toBe(true);
		const other = temporary(),
			binary = spec("events");
		generateFixture(join(other, "project"), join(other, "oracle"), binary, 42);
		expect(readFileSync(join(d, "oracle", "result-0.json"))).toEqual(
			readFileSync(join(other, "oracle", "result-0.json")),
		);
		writeFileSync(join(other, "project", "batch-index.txt"), "0");
		writeFileSync(join(other, "project", "events-0.bin"), Buffer.alloc(31));
		expect(() =>
			execFileSync("python3", [join(root, "poc/bench/three-way/workloads/reference.py")], {
				cwd: join(other, "project"),
				stdio: "pipe",
			}),
		).toThrow();
	});
	it("detects oracle changes and missing output", () => {
		const d = temporary(),
			cfg = spec("simulation");
		generateFixture(join(d, "project"), join(d, "oracle"), cfg, 42);
		expect(verifyWorkload(join(d, "project"), join(d, "oracle"), cfg, 0)).toMatchObject({
			pass: false,
			reason: "missing-or-invalid-output",
		});
		writeFileSync(join(d, "oracle", "result-0.bin"), "corrupt");
		expect(() => verifyWorkload(join(d, "project"), join(d, "oracle"), cfg, 0)).toThrow("Oracle content changed");
	});
	it("excludes warmups, requires all measured batches, and retains failed planned slots", () => {
		const item = workloadCases(root, "N01-graph", { scales: ["small"], cache: ["warm"] })[0];
		const slot: RunSlot = {
			runId: "one",
			caseId: item.id,
			variantId: "prime-ts",
			repetition: 1,
			caseHash: "test",
			modelId: "none-direct-runtime",
		};
		const trace = new Trace(temporary(), slot);
		trace.duration("cell.roundtrip", 1000, { warmup: true });
		trace.duration("cell.python_execute", 900, { warmup: true });
		trace.duration("cell.roundtrip", 10, { warmup: false });
		trace.duration("cell.python_execute", 7, { warmup: false });
		trace.duration("guest.compute", 4, { warmup: false });
		const run: RunResult = {
			...slot,
			applicable: true,
			status: "completed",
			checkPass: true,
			startedAt: null,
			timedOut: false,
			error: null,
			agentElapsedMs: 2000,
			userElapsedMs: 2000,
			validatedElapsedMs: 2001,
			turnExitCodes: [],
			requestCount: 0,
			sessionFile: null,
			peakSampledTreeRssBytes: null,
		};
		expect(workloadRow(item, run, trace.spans, 1, "prime-ts", "one")).toMatchObject({
			passed: true,
			roundtripMs: 10,
			executionMs: 7,
			computeMs: 4,
			warmupCells: 1,
		});
		expect(workloadRow(item, { ...run, timedOut: true }, trace.spans, 1, "prime-ts", "one").passed).toBe(false);
		const directory = temporary();
		const historicalControl = {
			...item,
			id: "historical-numpy-control",
			workload: { ...item.workload!, implementation: "numpy" as const },
		};
		const manifest: Manifest = {
			version: 1,
			createdAt: "2026-10-10T00:00:00.000Z",
			seed: 1,
			root,
			provider: null,
			cases: [item, historicalControl],
			variants: [
				{
					id: "prime-ts",
					baseRevision: "test",
					sourceRoot: root,
					command: "node",
					args: [],
					inputsHash: "test",
					launcherHash: "test",
				},
			],
			runs: [
				slot,
				{ ...slot, runId: "missing", repetition: 2 },
				{ ...slot, caseId: historicalControl.id, runId: "excluded" },
			],
			requestLimitPerRun: 64,
			collectorSourceHash: "test",
			profileCommands: false,
		};
		workloadReport(directory, manifest, [run], trace.spans);
		const report = JSON.parse(readFileSync(join(directory, "workloads.json"), "utf8"));
		expect(report.rows).toHaveLength(2);
		expect(report.groups).toHaveLength(1);
		expect(report.pairs).toHaveLength(0);
		expect(report.excludedPlannedRuns).toBe(1);
		expect(report.groups[0]).toMatchObject({ planned: 2, passed: 1, failedOrMissing: 1, roundtripMs: 10 });
		expect(report.rankingAllowed).toBe(false);
		const html = readFileSync(join(directory, "workloads.html"), "utf8");
		expect(html.toLowerCase()).not.toContain("numpy");
		expect(html).toContain("Runtime execution<br>(excludes Cargo/AOT)");
		expect(report.columnGuide).toHaveLength(13);
		expect(
			report.columnGuide.every(
				(c: { label: string; meaning: string; reading: string }) =>
					html.includes(c.meaning) && html.includes(c.reading),
			),
		).toBe(true);
		expect(html).toContain('data-metric="roundtripWithoutAllCompilationMs"');
		expect(html).toContain('data-metric="validatedWithoutAllCompilationMs"');
		expect(html).toContain('data-metric="executionMs"');
		expect(html).toContain("n=0 · passed 1/2");
		writeJson(join(directory, "manifest.json"), manifest);
		expect(analyze(directory)).toMatchObject({ plannedRuns: 2, excludedPlannedRuns: 1 });
		expect(
			workloadRow({ ...item, workload: { ...item.workload!, batches: 4 } }, run, trace.spans, 1, "prime-ts", "one")
				.roundtripMs,
		).toBeNull();
		const wasm = new Trace(temporary(), { ...slot, variantId: "wasmedge-aot" });
		wasm.duration("cell.roundtrip", 110, { warmup: false });
		wasm.duration("cell.compile", 60, { warmup: false });
		wasm.duration("cell.aot_compile", 30, { warmup: false });
		wasm.duration("cell.execution", 12, { warmup: false });
		expect(workloadRow(item, run, wasm.spans, 1, "wasmedge-aot", "one")).toMatchObject({
			roundtripMs: 110,
			executionMs: 12,
			cargoMs: 60,
			aotMs: 30,
		});
		expect(workloadRow(item, run, trace.spans, 1, "wasmedge-aot", "one").executionMs).toBeNull();
	});
	it("subtracts verified compiler unions per run, clips measured cells, and preserves unavailable timings", () => {
		const item = workloadCases(root, "N01-graph", { scales: ["small"], batches: [4], cache: ["warm"] })[0];
		const run: RunResult = {
			runId: "compiler-clipping",
			caseId: item.id,
			variantId: "wasmedge-aot",
			repetition: 1,
			caseHash: "test",
			modelId: "none-direct-runtime",
			applicable: true,
			status: "completed",
			startedAt: null,
			agentElapsedMs: 750,
			userElapsedMs: 750,
			validatedElapsedMs: 750,
			checkPass: true,
			timedOut: false,
			error: null,
			turnExitCodes: [],
			requestCount: 0,
			sessionFile: null,
			peakSampledTreeRssBytes: null,
			cargoCapture: {
				version: 1,
				complete: true,
				clockVerified: true,
				startedCommands: 4,
				completedCommands: 4,
				errors: [],
				method: "cargo-path-and-runtime-override",
			},
			aotCapture: {
				version: 1,
				complete: true,
				clockVerified: true,
				startedCommands: 2,
				completedCommands: 2,
				errors: [],
				method: "aot-runtime-override",
			},
		};
		const trace = new Trace(temporary(), run);
		const span = (name: string, start: number, end: number, attributes: Record<string, unknown> = {}) =>
			trace.add({
				name,
				startMonoNs: String(start * 1e6),
				endMonoNs: String(end * 1e6),
				durationMs: end - start,
				measurementState: "measured",
				outcome: "ok",
				attributes,
			});
		for (const name of ["task.agent_elapsed", "run.user_elapsed", "run.validated_elapsed"]) span(name, 0, 750);
		span("cell.roundtrip", 0, 40, { warmup: true });
		span("cell.roundtrip", 40, 80, { warmup: true });
		const measured = [100, 250, 400, 550].map((start) =>
			span("cell.roundtrip", start, start + 100, { warmup: false }),
		);
		for (const [start, end] of [
			[10, 30],
			[90, 150],
			[210, 240],
			[480, 580],
		])
			span("cargo.command", start, end, { commandId: `cargo-${start}`, provenance: "cargo-wrapper-command-wall" });
		for (const [start, end] of [
			[140, 190],
			[340, 420],
		])
			span("aot.command", start, end, { commandId: `aot-${start}`, provenance: "aot-wrapper-command-wall" });
		trace.duration("cell.compile", 999, { warmup: false });
		trace.duration("cell.aot_compile", 999, { warmup: false });
		const row = (value: RunResult = run) => workloadRow(item, value, trace.spans, 1, run.variantId, run.runId);
		expect(row()).toMatchObject({
			roundtripMs: 400,
			roundtripWithoutAllCompilationMs: 230,
			validatedWithoutAllCompilationMs: 420,
			warmupCells: 2,
		});
		expect(row({ ...run, aotCapture: undefined })).toMatchObject({
			roundtripWithoutAllCompilationMs: null,
			validatedWithoutAllCompilationMs: null,
		});
		expect(
			row({ ...run, cargoCapture: { ...run.cargoCapture!, complete: false } }).roundtripWithoutAllCompilationMs,
		).toBeNull();
		measured[0].clockId = "different-clock";
		expect(row()).toMatchObject({
			roundtripWithoutAllCompilationMs: null,
			validatedWithoutAllCompilationMs: 420,
			compilationAdjustmentReason: "invalid-cell-clock",
		});
		measured[0].clockId = trace.clockId;
		const python: RunResult = {
			...run,
			variantId: "prime-ts",
			cargoCapture: { ...run.cargoCapture!, startedCommands: 0, completedCommands: 0 },
			aotCapture: undefined,
		};
		const nonCompilerSpans = trace.spans.filter((s) => !["cargo.command", "aot.command"].includes(s.name));
		expect(workloadRow(item, python, nonCompilerSpans, 1, "prime-ts", run.runId)).toMatchObject({
			roundtripWithoutAllCompilationMs: 400,
			validatedWithoutAllCompilationMs: 750,
		});
	});
	it("rejects modified or deleted fixture inputs", () => {
		const directory = temporary(),
			project = join(directory, "project"),
			oracle = join(directory, "oracle");
		generateFixture(project, oracle, spec("simulation"), 1);
		expect(verifyFixtureInputs(project, oracle)).toBe(true);
		writeFileSync(join(project, "seeds-0.bin"), "corrupt");
		expect(verifyFixtureInputs(project, oracle)).toBe(false);
		rmSync(join(project, "seeds-0.bin"));
		expect(verifyFixtureInputs(project, oracle)).toBe(false);
	});
	it.each([false, true])("requires fresh cell output and classifies deadlines (stall=%s)", async (stall) => {
		const directory = temporary(),
			project = join(directory, "project");
		const item = workloadCases(root, "N01-graph", { scales: ["small"] })[0];
		item.workload = spec("graph");
		generateFixture(project, join(directory, "oracle"), item.workload, 1);
		copyFileSync(join(directory, "oracle", "result-0.bin"), join(project, "result-0.bin"));
		const adapter = join(directory, "adapter.mjs");
		writeFileSync(
			adapter,
			`import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.op === "execute" && ${stall}) return;
  console.log(JSON.stringify({id: request.id, status: "ok", result: {status: "ok", stdout: "BENCH_OK"}}));
});`,
		);
		const prepared: Prepared = {
			version: 1,
			variants: [
				{
					id: "prime-ts",
					baseRevision: "test",
					sourceRoot: root,
					command: process.execPath,
					args: [],
					inputsHash: "test",
					launcherHash: "test",
				},
			],
			runtimeCommands: { "prime-ts": { command: process.execPath, args: [adapter] } },
			env: {},
			identity: {},
		};
		const trace = new Trace(directory, {
			runId: "fresh-output",
			caseId: item.id,
			caseHash: "test",
			variantId: "prime-ts",
			repetition: 1,
			modelId: "none-direct-runtime",
		});
		const execution = directRuntime(
			prepared,
			"prime-ts",
			item,
			trace,
			process.env,
			project,
			join(directory, "workspace"),
			Date.now() + 1000,
		);
		if (stall) {
			await expect(execution).rejects.toBeInstanceOf(RuntimeDeadlineError);
			expect(trace.spans.find((s) => s.name === "cell.roundtrip")?.outcome).toBe("timeout");
		} else {
			await expect(execution).resolves.toBe(false);
			expect(verifyWorkload(project, join(directory, "oracle"), item.workload, 0).reason).toBe(
				"missing-or-invalid-output",
			);
		}
	});
});
