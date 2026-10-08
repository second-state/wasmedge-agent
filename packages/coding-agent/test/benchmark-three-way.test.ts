import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureCargo, importCargo } from "../../../poc/bench/three-way/cargo.js";
import { cases } from "../../../poc/bench/three-way/cases.js";
import { auditCellContract, cellPrompt } from "../../../poc/bench/three-way/cell-contract.js";
import { buildChartData } from "../../../poc/bench/three-way/charts.js";
import { commandPhase, importCommands, profileCommands } from "../../../poc/bench/three-way/commands.js";
import { subtractCompilation } from "../../../poc/bench/three-way/compilation.js";
import { cellExecution } from "../../../poc/bench/three-way/execution.js";
import { hashTree, readJson, StreamArtifact, writeJson } from "../../../poc/bench/three-way/files.js";
import { replayChunks, SseDecoder, startGateway } from "../../../poc/bench/three-way/gateway.js";
import { cleanEnvironment, timedProcess } from "../../../poc/bench/three-way/process.js";
import { credentials, modelsConfig } from "../../../poc/bench/three-way/provider.js";
import { analyze, csv, quantile } from "../../../poc/bench/three-way/report.js";
import { plan, randomizedSlots } from "../../../poc/bench/three-way/runner.js";
import { importCell } from "../../../poc/bench/three-way/runtime.js";
import { Trace } from "../../../poc/bench/three-way/trace.js";
import type { RunResult, RunSlot } from "../../../poc/bench/three-way/types.js";

const roots: string[] = [];
const temporary = () => {
	const directory = mkdtempSync(join(tmpdir(), "three-way-test-"));
	roots.push(directory);
	return directory;
};
const slot: RunSlot = {
	runId: "run-test",
	variantId: "wasmedge",
	caseId: "R01",
	repetition: 1,
	caseHash: "fixture",
	modelId: "none",
};
const benchmarkRun = (overrides: Partial<RunResult> = {}): RunResult => ({
	...slot,
	applicable: true,
	status: "completed",
	startedAt: null,
	agentElapsedMs: 500,
	userElapsedMs: 550,
	validatedElapsedMs: 650,
	cargoCapture: {
		version: 1,
		complete: true,
		clockVerified: true,
		startedCommands: 0,
		completedCommands: 0,
		errors: [],
		method: "cargo-path-and-runtime-override",
	},
	checkPass: true,
	timedOut: false,
	error: null,
	turnExitCodes: [0],
	requestCount: 0,
	sessionFile: null,
	peakSampledTreeRssBytes: null,
	...overrides,
});
const collectorSpan = (trace: Trace, name: string, startMs: number, endMs: number, attributes = {}) =>
	trace.add({
		name,
		startMonoNs: String(startMs * 1e6),
		endMonoNs: String(endMs * 1e6),
		durationMs: endMs - startMs,
		measurementState: "measured",
		outcome: "ok",
		attributes,
	});
const cargoObservation = (trace: Trace, startMs: number, endMs: number, id: string) =>
	collectorSpan(trace, "cargo.command", startMs, endMs, { provenance: "cargo-wrapper-command-wall", commandId: id });
const elapsedSpans = (trace: Trace, agent = 500, user = 550, validated = 650) => {
	collectorSpan(trace, "task.agent_elapsed", 50, 50 + agent);
	collectorSpan(trace, "run.user_elapsed", 0, user);
	collectorSpan(trace, "run.validated_elapsed", 0, validated);
};
const capturedRun = (commands: number, overrides: Partial<RunResult> = {}) =>
	benchmarkRun({
		...overrides,
		cargoCapture: {
			version: 1,
			complete: true,
			clockVerified: true,
			startedCommands: commands,
			completedCommands: commands,
			errors: [],
			method: "cargo-path-and-runtime-override",
		},
	});
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("three-way benchmark collector", () => {
	it("defaults paid tasks to cell-only work with a common external checker", () => {
		const root = temporary(),
			prepared = join(root, "prepared.json");
		writeJson(prepared, {
			variants: [{ id: "prime-ts" }, { id: "prime-rust" }, { id: "wasmedge" }, { id: "wasmedge-aot" }],
			identity: {},
		});
		const manifest = plan(
			resolve("../.."),
			prepared,
			{
				api: "openai-completions",
				baseUrl: "https://example.test",
				modelId: "faux",
				modelIdentity: "advertised-id-not-independent-revision-verification",
				contextWindow: 1000,
				maxTokens: 1000,
			},
			"E-11-join-report",
			1,
			42,
			join(root, "plan"),
		);
		expect(manifest.cases[0].tools).toBe("runtime-only");
		expect(manifest.cases[0].parameters.validationPolicy).toBe("external-checker-after-agent-no-shell-in-cells");
		expect(cellPrompt("task", "wasmedge")).toContain("execute Rust cells");
		expect(cellPrompt("task", "prime-rust")).toContain("execute Python cells");
		expect(cellPrompt("task", "wasmedge")).toContain("Do not launch those external commands yourself");
	});
	it("requires actual successful runtime cells in every turn and saves generated sources", () => {
		const directory = temporary(),
			item = { ...cases(resolve("../.."), "E-09-helper-accumulation")[0], tools: "runtime-only" as const };
		const events = item.turns.flatMap((_, index) => [
			{
				type: "agent_event",
				turnId: `turn-${index + 1}`,
				event: {
					type: "tool_execution_start",
					toolCallId: `cell-${index}`,
					toolName: "rust",
					args: { code: 'fn main(){println!("OK");}' },
				},
			},
			{
				type: "agent_event",
				turnId: `turn-${index + 1}`,
				event: {
					type: "tool_execution_end",
					toolCallId: `cell-${index}`,
					toolName: "rust",
					isError: false,
					result: { details: { status: "ok", timings: { executionMs: 1 } } },
				},
			},
		]);
		writeFileSync(join(directory, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
		const audit = auditCellContract(directory, item, "wasmedge");
		expect(audit).toMatchObject({
			status: "compliant",
			successfulCells: 3,
			cellsPerTurn: { "turn-1": 1, "turn-2": 1, "turn-3": 1 },
		});
		expect(readFileSync(join(directory, audit.sources[0].path), "utf8")).toBe('fn main(){println!("OK");}');
		writeFileSync(
			join(directory, "events.jsonl"),
			events
				.slice(0, 4)
				.map((event) => JSON.stringify(event))
				.join("\n"),
		);
		expect(auditCellContract(directory, item, "wasmedge")).toMatchObject({
			status: "violated",
			violations: ["turn-3: no successful measured rust cell execution"],
		});
	});
	it("rejects standalone bash and Python cells that wrap shell work", () => {
		const directory = temporary(),
			item = { ...cases(resolve("../.."), "E-11-join-report")[0], tools: "runtime-only" as const };
		const events = [
			{ type: "tool_execution_start", toolCallId: "bad-tool", toolName: "bash", args: { command: "echo OK" } },
			{
				type: "tool_execution_start",
				toolCallId: "cell",
				toolName: "ipython",
				args: { code: "await bash('sort orders.csv > spend.md')" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "cell",
				toolName: "ipython",
				isError: false,
				result: { details: { status: "ok", durationMs: 1, bashCommands: { count: 1 } } },
			},
		];
		writeFileSync(
			join(directory, "events.jsonl"),
			events.map((event) => JSON.stringify({ type: "agent_event", turnId: "turn-1", event })).join("\n"),
		);
		const audit = auditCellContract(directory, item, "prime-ts");
		expect(audit.status).toBe("violated");
		expect(audit.violations).toContain("turn-1: unexpected tool bash; required ipython");
		expect(audit.violations).toContain("turn-1: runtime reported a shell command");
		expect(audit.violations.some((reason) => reason.includes("shell or external-process API"))).toBe(true);
	});
	it("excludes uncontrolled historical tool-choice results from cell latency comparisons", () => {
		const directory = temporary(),
			item = { ...cases(resolve("../.."), "E-11-join-report")[0], tools: "native" as const };
		const audit = auditCellContract(directory, item, "wasmedge");
		expect(audit.status).toBe("not-controlled");
		const run = benchmarkRun({ caseId: item.id, cellContract: audit });
		const charts = buildChartData([item], [{ id: "wasmedge" }], [run], [run], []);
		expect(charts.cases[0]).toMatchObject({
			counts: { passed: 1 },
			contractExcludedSamples: 1,
			successSamples: 0,
			agentMs: null,
			penalizedMs: null,
		});
		expect(charts.compilationRuns[0]).toMatchObject({
			state: "excluded",
			reason: "cell-comparison-contract-not-met",
			agentWithoutCompilationMs: null,
		});
	});
	it("deducts all Cargo intervals once and clips checker costs to the selected elapsed period", () => {
		const run = capturedRun(4),
			trace = new Trace(temporary(), run);
		elapsedSpans(trace);
		cargoObservation(trace, 10, 100, "init");
		cargoObservation(trace, 200, 300, "cell");
		cargoObservation(trace, 250, 350, "parallel");
		cargoObservation(trace, 560, 620, "checker");
		trace.duration("cell.compile", 150);
		trace.duration("compiler.rustc_unit", 99);
		expect(subtractCompilation(run, trace.spans)).toMatchObject({
			state: "measured",
			compileMs: 300,
			agentCargoMs: 200,
			userCargoMs: 240,
			validatedCargoMs: 300,
			agentWithoutCompilationMs: 300,
			userWithoutCompilationMs: 310,
			validatedWithoutCompilationMs: 350,
			compileObservations: 4,
		});
	});
	it("subtracts per run before taking medians with identical paired raw samples", () => {
		const runs = [100, 200, 300, 10000].map((total, index) =>
			capturedRun(1, {
				runId: `median-${index}`,
				agentElapsedMs: total,
				userElapsedMs: total + 50,
				validatedElapsedMs: total + 100,
			}),
		);
		const spans = runs.flatMap((run, index) => {
			if (index === 3) return [];
			const trace = new Trace(temporary(), run);
			elapsedSpans(trace, run.agentElapsedMs!, run.userElapsedMs!, run.validatedElapsedMs!);
			cargoObservation(trace, 50, 50 + [90, 190, 0][index], "cargo");
			return trace.spans;
		});
		const charts = buildChartData(
			[{ id: slot.caseId, lane: "runtime", scale: "test", taskBudgetMs: 1000 }],
			[{ id: "wasmedge" }],
			runs,
			runs,
			spans,
		);
		expect(charts.cases[0].withoutCompilation).toMatchObject({
			agentMs: 10,
			rawAgentMs: 200,
			agentSamples: 3,
			unavailableSamples: 1,
		});
		expect(charts.compilationRuns.map((run) => run.agentWithoutCompilationMs)).toEqual([10, 10, 300, null]);
	});
	it("reports Cargo and AOT separately and subtracts their union without double counting", () => {
		const run = capturedRun(1, {
			variantId: "wasmedge-aot",
			aotCapture: {
				version: 1,
				complete: true,
				clockVerified: true,
				startedCommands: 1,
				completedCommands: 1,
				errors: [],
				method: "aot-runtime-override",
			},
		});
		const trace = new Trace(temporary(), run);
		elapsedSpans(trace);
		cargoObservation(trace, 100, 200, "cargo");
		collectorSpan(trace, "aot.command", 150, 250, { commandId: "aot", provenance: "aot-wrapper-command-wall" });
		expect(subtractCompilation(run, trace.spans)).toMatchObject({
			agentCargoMs: 100,
			agentAotMs: 100,
			agentCompilerMs: 150,
			agentWithoutCompilationMs: 400,
			agentWithoutAllCompilationMs: 350,
		});
		const missing = subtractCompilation({ ...run, aotCapture: undefined }, trace.spans);
		expect(missing.agentWithoutCompilationMs).toBe(400);
		expect(missing.agentWithoutAllCompilationMs).toBeNull();
		trace.spans.find((span) => span.name === "aot.command")!.clockId = "wrong-clock";
		expect(subtractCompilation(run, trace.spans).agentWithoutAllCompilationMs).toBeNull();
	});
	it("retains identical reference Rust cells in both WasmEdge modes", () => {
		for (const item of cases(resolve("../.."), "runtime"))
			expect(item.runtime?.["wasmedge-aot"]).toEqual(item.runtime?.wasmedge);
		expect(cellPrompt("task", "wasmedge-aot")).toContain("execute Rust cells");
	});
	it("distinguishes AOT compiler failure from runtime and Cargo failure", () => {
		const run = benchmarkRun({ variantId: "wasmedge-aot" });
		const trace = new Trace(temporary(), run);
		collectorSpan(trace, "tool.execution", 0, 1, { toolName: "rust", toolCallId: "aot-error" });
		importCell(
			trace,
			{
				status: "error",
				runtimeMode: "aot",
				aotCompileFailed: true,
				timings: { cargoMs: 12, aotCompileMs: 100, executionMs: 0 },
			},
			{ cellId: "aot-error" },
		);
		expect(cellExecution(run, trace.spans)).toMatchObject({
			aotFailures: 1,
			compileFailures: 0,
			runtimeFailures: 0,
			measuredCells: 0,
		});
	});
	it("requires complete Cargo capture for all versions rather than treating historical Python runs as zero", () => {
		const run = benchmarkRun(),
			trace = new Trace(temporary(), run);
		elapsedSpans(trace);
		expect(subtractCompilation(run, trace.spans)).toMatchObject({
			state: "not_run",
			compileMs: 0,
			validatedWithoutCompilationMs: 650,
		});
		expect(
			subtractCompilation({ ...run, variantId: "prime-ts", cargoCapture: undefined }, trace.spans),
		).toMatchObject({ state: "unavailable", compileMs: null });
		expect(
			subtractCompilation({ ...run, cargoCapture: { ...run.cargoCapture!, complete: false } }, trace.spans).state,
		).toBe("unavailable");
		expect(subtractCompilation({ ...run, checkPass: false }, trace.spans).state).toBe("excluded");
	});
	it("rejects wrong clocks, duplicate commands and inconsistent elapsed durations", () => {
		const run = capturedRun(1),
			trace = new Trace(temporary(), run);
		elapsedSpans(trace);
		const command = cargoObservation(trace, 50, 100, "cargo");
		expect(subtractCompilation({ ...run, agentElapsedMs: 40 }, trace.spans).reason).toBe("elapsed-clock-mismatch");
		command.clockId = "unverified";
		expect(subtractCompilation(run, trace.spans).reason).toBe("missing-task-clock");
		command.clockId = trace.clockId;
		cargoObservation(trace, 150, 200, "cargo");
		expect(subtractCompilation(capturedRun(2), trace.spans).reason).toBe("invalid-cargo-clock-or-identity");
	});
	it("captures PATH and absolute runtime Cargo, preserves output and retains incomplete commands", async () => {
		const directory = temporary(),
			bin = join(directory, "original-bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "cargo"), '#!/bin/sh\nprintf "cargo-output\\n"\nexit 7\n', { mode: 0o700 });
		const trace = new Trace(directory, slot),
			env = cleanEnvironment({ PATH: `${bin}:${process.env.PATH}` });
		captureCargo(trace, resolve("../.."), env);
		for (const command of ["cargo", env.WASMEDGE_AGENT_CARGO!]) {
			const result = await timedProcess(command, ["test"], directory, env, join(directory, "output.log"), 15_000);
			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(7);
		}
		expect(readFileSync(join(directory, "output.log"), "utf8")).toBe("cargo-output\ncargo-output\n");
		expect(importCargo(trace)).toMatchObject({
			complete: true,
			clockVerified: true,
			startedCommands: 2,
			completedCommands: 2,
		});
		expect(trace.spans.every((span) => span.clockId === trace.clockId && span.outcome === "error")).toBe(true);
		const log = join(directory, "cargo-commands.jsonl"),
			lines = readFileSync(log, "utf8").trim().split("\n");
		writeFileSync(log, `${lines.slice(0, -1).join("\n")}\n`);
		expect(importCargo(trace)).toMatchObject({ complete: false, startedCommands: 2, completedCommands: 1 });
		writeFileSync(log, `${lines.join("\n")}\n`);
		writeJson(join(directory, "cargo-clock-calibration.json"), { clockId: "wrong", calibration: [] });
		expect(importCargo(trace)).toMatchObject({ complete: false, clockVerified: false });
	});
	it("compares runtime execution without compile/snapshot and preserves runtime and compile failures", () => {
		const run = benchmarkRun(),
			trace = new Trace(temporary(), run);
		for (const [id, status, ms] of [
			["ok", "ok", 7],
			["runtime", "error", 3],
			["compile", "compile_error", 0],
		] as const) {
			collectorSpan(trace, "tool.execution", 0, 1, { toolName: "rust", toolCallId: id });
			importCell(
				trace,
				{ status, timings: { cargoMs: 100, executionMs: ms, snapshotMs: 25 }, toolTiming: { totalMs: 200 } },
				{ cellId: id },
			);
		}
		expect(cellExecution(run, trace.spans)).toMatchObject({
			state: "measured",
			cellCalls: 3,
			successfulCells: 1,
			runtimeFailures: 1,
			compileFailures: 1,
			totalExecutionMs: 10,
			failedExecutionMs: 3,
			meanSuccessfulCellMs: 7,
		});
		expect(trace.spans.find((span) => span.name === "cell.execution" && span.cellId === "runtime")?.outcome).toBe(
			"error",
		);
		trace.spans.splice(
			trace.spans.findIndex((span) => span.name === "cell.execution" && span.cellId === "ok"),
			1,
		);
		expect(cellExecution(run, trace.spans)).toMatchObject({
			state: "unavailable",
			totalExecutionMs: null,
			missingCells: 1,
		});
	});
	it("uses Python runtime-reported durations including sub-resolution zero and rejects duplicate cell IDs", () => {
		const run = benchmarkRun({ variantId: "prime-rust" }),
			trace = new Trace(temporary(), run);
		collectorSpan(trace, "tool.execution", 0, 0.01, { toolCallId: "python", toolName: "ipython" });
		importCell(trace, { status: "ok", durationMs: 0 }, { cellId: "python" });
		expect(cellExecution(run, trace.spans)).toMatchObject({
			state: "measured",
			totalExecutionMs: 0,
			zeroResolutionCells: 1,
		});
		importCell(trace, { status: "ok", durationMs: 5 }, { cellId: "python" });
		expect(cellExecution(run, trace.spans)).toMatchObject({ state: "unavailable", totalExecutionMs: null });
	});
	it("exports auditable Cargo subtraction and cell execution JSON and CSV", () => {
		const root = temporary(),
			run = benchmarkRun({ caseId: "H01-startup", variantId: "prime-ts" });
		writeJson(join(root, "manifest.json"), {
			createdAt: "2026-10-08T00:00:00Z",
			provider: null,
			cases: cases(resolve("../.."), "H01-startup"),
			variants: [{ id: "prime-ts" }],
			runs: [run],
		});
		const trace = new Trace(join(root, "runs", run.runId), run);
		elapsedSpans(trace);
		writeJson(join(trace.directory, "result.json"), run);
		const report = analyze(root);
		expect(report.compilationScope).toBe("all-run-cargo-and-aot-command-wall-v1");
		expect(report.compilationAdjustedRuns).toEqual([
			expect.objectContaining({ state: "not_run", validatedWithoutCompilationMs: 650 }),
		]);
		expect(readFileSync(join(root, "compilation-adjusted-runs.csv"), "utf8")).toContain('"validatedCargoMs"');
		expect(readFileSync(join(root, "cell-execution-runs.csv"), "utf8")).toContain('"meanSuccessfulCellMs"');
	});
	it("keeps failed, inapplicable and unexecuted slots visible without inventing success latencies", () => {
		const slots = Array.from({ length: 5 }, (_, index) => ({ ...slot, runId: `r${index}` }));
		const result = (index: number, overrides: Partial<RunResult>): RunResult => ({
			...slots[index],
			applicable: true,
			status: "completed",
			startedAt: null,
			agentElapsedMs: 10,
			userElapsedMs: 15,
			checkPass: true,
			timedOut: false,
			error: null,
			turnExitCodes: [0],
			requestCount: 0,
			sessionFile: null,
			peakSampledTreeRssBytes: null,
			...overrides,
		});
		const input = [
			result(0, {}),
			result(1, { checkPass: false, agentElapsedMs: 1 }),
			result(2, { applicable: false, checkPass: null, agentElapsedMs: null }),
			result(3, { status: "infrastructure_error", checkPass: null, agentElapsedMs: null }),
		];
		const charts = buildChartData(
			[{ id: slot.caseId, lane: "runtime", scale: "test", taskBudgetMs: 100 }],
			[{ id: "wasmedge" }],
			slots,
			input,
			[],
		);
		expect(charts.cases[0]).toMatchObject({
			counts: { passed: 1, failed: 1, notApplicable: 1, infrastructure: 1, unexecuted: 1 },
			agentMs: 10,
			userMs: 15,
			penalizedMs: 55,
		});
		const failedOnly = buildChartData(
			[{ id: slot.caseId, lane: "runtime", scale: "test", taskBudgetMs: 100 }],
			[{ id: "wasmedge" }],
			[slots[1]],
			[input[1]],
			[],
		);
		expect(failedOnly.cases[0].agentMs).toBeNull();
	});
	it("charts overlapping phase totals separately and preserves missing states and measured errors", () => {
		const trace = new Trace(temporary(), slot);
		trace.duration("cell.tool_total", 100);
		trace.duration("cell.compile", 80);
		trace.duration("cell.compile", 120, {}, "compile_error");
		trace.unavailable("cell.compile", "not_run", "not invoked");
		trace.unavailable("compiler.link", "missing", "no hook");
		const charts = buildChartData([], [], [], [], trace.spans);
		expect(charts.phases.find((row) => row.phase === "cell.tool_total")?.medianMs).toBe(100);
		expect(charts.phases.find((row) => row.phase === "cell.compile")).toMatchObject({
			medianMs: 100,
			observations: 2,
			errorObservations: 1,
			states: { measured: 2, not_run: 1 },
		});
		expect(charts.phases.find((row) => row.phase === "compiler.link")?.medianMs).toBeNull();
	});
	it("embeds chart data without allowing script terminators or template tokens to change the page", () => {
		const root = temporary();
		const caseId = "</script><script>__BENCH_CLIENT__</script>";
		const items = [{ ...cases(resolve("../.."), "H01-startup")[0], id: caseId }];
		writeJson(join(root, "manifest.json"), {
			createdAt: "2026-10-08T00:00:00Z",
			provider: null,
			cases: items,
			variants: [{ id: "prime-ts" }],
			runs: randomizedSlots(items, ["prime-ts"], 1, 42, "model"),
		});
		analyze(root);
		const html = readFileSync(join(root, "report.html"), "utf8");
		expect(html).not.toContain(caseId);
		const embedded = html.match(/<script id="benchmark-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
		expect(JSON.parse(embedded!).charts.cases[0].caseId).toBe(caseId);
	});
	it("profiles native commands without altering their output or exit status", async () => {
		const directory = temporary(),
			trace = new Trace(directory, slot),
			env = cleanEnvironment();
		env.PATH = profileCommands(directory, resolve("../.."), env);
		const result = await timedProcess(
			"node",
			["-e", "console.log('native-output');process.exitCode=7"],
			directory,
			env,
			join(directory, "output.log"),
			15_000,
		);
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(7);
		expect(readFileSync(join(directory, "output.log"), "utf8")).toBe("native-output\n");
		importCommands(trace, join(directory, "native-commands.jsonl"));
		expect(trace.spans).toHaveLength(1);
		expect(trace.spans[0].outcome).toBe("error");
		expect(commandPhase("/bin/cargo", ["test"])).toBe("project.build_test_command");
		expect(commandPhase("/bin/cargo", ["build", "-p", "cell"])).toBe("compiler.control_cell_command");
	});
	it("saves streaming artifacts incrementally and redacts secrets split across bytes", () => {
		const path = join(temporary(), "paid-output.sse"),
			artifact = new StreamArtifact(path, "test-secret");
		for (const byte of Buffer.from("data: 測試 test-secret tail\n\n")) artifact.push(Uint8Array.of(byte));
		expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
		artifact.push(new Uint8Array(), true);
		expect(readFileSync(path, "utf8")).toBe("data: 測試 [REDACTED] tail\n\n");
	});
	it("decodes split UTF-8 and CRLF frames including multiline data", () => {
		const received: string[] = [],
			decoder = new SseDecoder((value) => received.push(value));
		const bytes = Buffer.from('data: {"text":"測試"}\r\n\r\ndata: first\ndata: second\n\n');
		for (const byte of bytes) decoder.push(Uint8Array.of(byte));
		decoder.push(new Uint8Array(), true);
		expect(received).toEqual(['{"text":"測試"}', "first\nsecond"]);
	});
	it("rejects truncated SSE instead of treating it as a successful complete response", () => {
		const decoder = new SseDecoder(() => {});
		decoder.push(Buffer.from("data: {}\n"));
		expect(() => decoder.push(new Uint8Array(), true)).toThrow("Truncated SSE");
	});
	it("replays exact tool arguments across small Unicode chunks", () => {
		const values: string[] = [],
			decoder = new SseDecoder((data) => values.push(data));
		for (const chunk of replayChunks(
			{ tool: { name: "rust", arguments: { code: 'fn main(){println!("測試");}' } }, chunkBytes: 1 },
			"model",
			1,
		))
			decoder.push(chunk);
		const fragments = values
			.filter((value) => value !== "[DONE]")
			.map((value) => JSON.parse(value).choices[0].delta.tool_calls?.[0]?.function.arguments ?? "")
			.join("");
		expect(JSON.parse(fragments).code).toBe('fn main(){println!("測試");}');
	});
	it("records source emission with byte provenance and refuses excess model requests", async () => {
		const trace = new Trace(temporary(), slot),
			controller = new AbortController();
		const gateway = await startGateway({
			trace,
			modelId: "model",
			provider: null,
			replay: [
				{
					tool: {
						name: "rust",
						arguments: {
							code: 'fn main(){println!("測試");}',
							lib: [{ path: "helper.rs", content: "pub fn answer()->u32{42}" }],
						},
					},
					chunkBytes: 2,
				},
			],
			limit: 1,
			signal: controller.signal,
		});
		try {
			const send = () =>
				fetch(`${gateway.baseUrl}/chat/completions`, {
					method: "POST",
					headers: { Authorization: `Bearer ${gateway.token}` },
					body: JSON.stringify({ model: "model", stream: true, messages: [] }),
				});
			const response = await send();
			expect(response.status).toBe(200);
			await response.text();
			expect(trace.spans.filter((span) => span.name === "llm.code_emission")).toHaveLength(2);
			expect(trace.spans.find((span) => span.name === "llm.code_emission")?.attributes.sourceBytes).toBe(
				Buffer.byteLength('fn main(){println!("測試");}'),
			);
			expect((await send()).status).toBe(429);
			expect(readdirSync(trace.directory)).toContain("request-1.response.sse");
			expect(trace.spans.find((span) => span.name === "llm.time_to_first_reasoning")?.measurementState).toBe(
				"not_run",
			);
		} finally {
			controller.abort();
			await gateway.close();
		}
	});
	it("preserves failure timing, marks execution not-run and keeps imported clocks isolated", () => {
		const trace = new Trace(temporary(), slot);
		importCell(
			trace,
			{
				status: "compile_error",
				timings: { cargoMs: 12, executionMs: 0 },
				toolTiming: { provisionMs: 2, totalMs: 20 },
			},
			{ cellId: "cell" },
		);
		expect(trace.spans.find((span) => span.name === "cell.compile")?.outcome).toBe("compile_error");
		expect(trace.spans.find((span) => span.name === "cell.execution")?.durationMs).toBeNull();
		expect(trace.spans.find((span) => span.name === "cell.execution")?.measurementState).toBe("not_run");
		expect(trace.spans.find((span) => span.name === "cell.compile")?.clockId).toMatch(/^duration-only:/);
		expect(trace.spans.find((span) => span.name === "cell.compile")?.cellId).toBe("cell");
	});
	it("distinguishes Python preparation missing from Cargo not-applicable", () => {
		const trace = new Trace(temporary(), { ...slot, variantId: "prime-ts" });
		importCell(trace, { status: "ok", durationMs: 5 }, {});
		expect(trace.spans.find((span) => span.name === "cell.compile")?.measurementState).toBe("not_applicable");
		expect(trace.spans.find((span) => span.name === "cell.python_prepare")?.measurementState).toBe("missing");
	});
	it("retains incomplete spans instead of inventing an end boundary", () => {
		const trace = new Trace(temporary(), slot);
		trace.start("cell.compile");
		trace.finishIncomplete("aborted");
		expect(trace.spans[0]).toMatchObject({
			measurementState: "incomplete",
			outcome: "aborted",
			endMonoNs: null,
			durationMs: null,
		});
		expect(trace.spans[0].startMonoNs).not.toBeNull();
	});
	it("keeps credentials outside the agent environment and config", () => {
		expect(credentials({ PRIME_AGENT_BASE_URL: "https://example.test", PRIME_AGENT_API_KEY: "test-value" })).toEqual({
			baseUrl: "https://example.test",
			apiKey: "test-value",
		});
		expect(() =>
			credentials({ PRIME_AGENT_BASE_URL: "https://user:secret@example.test", PRIME_AGENT_API_KEY: "test" }),
		).toThrow();
		expect(cleanEnvironment().PRIME_AGENT_API_KEY).toBeUndefined();
		expect(JSON.stringify(modelsConfig("http://localhost:1/v1", "model"))).toContain("BENCH_GATEWAY_TOKEN");
	});
	it("produces paired randomized slots with identical Python reference cells", () => {
		const items = cases(resolve("../.."), "runtime");
		expect(items).toHaveLength(16);
		for (const item of items) expect(item.runtime?.["prime-ts"]).toEqual(item.runtime?.["prime-rust"]);
		const order = () =>
			randomizedSlots(items, ["prime-ts", "prime-rust", "wasmedge"], 2, 42, "model").map(
				({ runId: _id, ...value }) => value,
			);
		expect(order()).toEqual(order());
		expect(order()).toHaveLength(96);
	});
	it("hashes content while ignoring generated runtime bytecode", () => {
		const root = temporary();
		writeFileSync(join(root, "source.txt"), "one");
		const first = hashTree(root);
		writeFileSync(join(root, "source.txt"), "two");
		expect(hashTree(root)).not.toBe(first);
	});
	it("kills the owned process on deadline and preserves partial output", async () => {
		const root = temporary(),
			log = join(root, "process.log");
		const result = await timedProcess(
			process.execPath,
			["-e", "console.log('partial');setTimeout(()=>{},60000)"],
			root,
			cleanEnvironment(),
			log,
			150,
		);
		expect(result.timedOut).toBe(true);
		expect(readFileSync(log, "utf8")).toContain("partial");
	});
	it("penalizes failed tasks and blocks incomplete-plan ranking", () => {
		const root = temporary(),
			items = cases(resolve("../.."), "H01-startup"),
			runs = randomizedSlots(items, ["prime-ts", "prime-rust"], 1, 42, "model");
		writeJson(join(root, "manifest.json"), {
			createdAt: "test",
			provider: null,
			cases: items,
			variants: [{ id: "prime-ts" }, { id: "prime-rust" }],
			runs,
		});
		writeJson(join(root, "runs", runs[0].runId, "result.json"), {
			...runs[0],
			applicable: true,
			status: "completed",
			checkPass: false,
			agentElapsedMs: 1,
			requestCount: 0,
		});
		const report = analyze(root);
		expect(report.complete).toBe(false);
		expect(report.rankingAllowed).toBe(false);
		const value = readJson(join(root, "report.json")) as {
			taskSummary: { recorded: number; penalizedMeanMs: number }[];
		};
		expect(value.taskSummary.find((item) => item.recorded === 1)?.penalizedMeanMs).toBe(60000);
	});
	it("exports quoted CSV and leaves unsupported quantiles null", () => {
		expect(csv([{ value: 'a,"b"\nc' }], ["value"])).toContain('"a,""b""\nc"');
		expect(quantile([], 0.5)).toBeNull();
		expect(quantile([1, 3], 0.5)).toBe(2);
	});
});
