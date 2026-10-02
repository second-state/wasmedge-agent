import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "benchmark-analyze-"));
	roots.push(root);
	// The standalone analyzer locates results relative to itself. Copy it so
	// these offline fixtures never read or overwrite a user's benchmark runs.
	const analyzer = join(root, "analyze.ts");
	copyFileSync(join(repo, "poc/bench/analyze.ts"), analyzer);
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	mkdirSync(join(root, "results/runs"), { recursive: true });
	let nextId = 0;
	return {
		add({
			task = "fixture",
			model = "fixture-model",
			group = "A",
			variant = "example",
			tokensOut,
			tokensIn = 0,
			durations = [],
			pass = true,
		}: {
			task?: string;
			model?: string;
			group?: string;
			variant?: string;
			tokensOut: number;
			tokensIn?: number;
			durations?: number[];
			pass?: boolean;
		}) {
			const runId = String(++nextId);
			const dir = join(root, "results/runs", runId);
			mkdirSync(dir);
			const sessionFile = join(dir, "session.jsonl");
			const messages = [
				{ role: "assistant", usage: { input: tokensIn, output: tokensOut } },
				...durations.map((durationMs) => ({
					role: "toolResult",
					toolName: group === "A" ? "ipython" : "rust",
					details: { durationMs, status: "ok" },
				})),
			];
			writeFileSync(sessionFile, messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"));
			const metaPath = join(dir, "meta.json");
			writeFileSync(
				metaPath,
				JSON.stringify({
					runId,
					task,
					category: "fixture",
					model,
					group,
					variant,
					rep: nextId,
					checkPass: pass,
					timedOut: false,
					wallMs: 1,
					sessionFile,
				}),
			);
			return { sessionFile, metaPath };
		},
		run() {
			const csv = join(root, "metrics.csv");
			const stdout = execFileSync(process.execPath, ["--experimental-strip-types", analyzer, "--csv", csv], {
				encoding: "utf-8",
				timeout: 10_000,
			});
			return { stdout, csv: readFileSync(csv, "utf-8") };
		},
	};
}

function csvRows(csv: string) {
	const [header, ...lines] = csv.split("\n");
	const columns = header.split(",");
	return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [columns[index], value])));
}

function writeMessages(path: string, messages: unknown[]) {
	writeFileSync(path, messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"));
}

function rustResult(status: unknown, isError?: boolean) {
	return { role: "toolResult", toolName: "rust", details: { status }, isError };
}

function writeRustCells(path: string, statuses: unknown[]) {
	writeMessages(path, [
		{ role: "assistant", usage: { input: 0, output: 100 } },
		...statuses.map((status) => rustResult(status)),
	]);
}

function recoverySummary(stdout: string, condition: string) {
	const section = stdout.split("\nCompile-error recovery (Rust cells):\n")[1];
	expect(section, "missing recovery summary").toBeDefined();
	const line = section!.split("\n").find((line) => line.startsWith(`${condition} `));
	expect(line, `missing recovery aggregate for ${condition}`).toBeDefined();
	const [recoveredErrors, unrecoveredErrors, unrecoveredRuns, meanCells] = line!
		.slice(condition.length)
		.trim()
		.split(/\s+/)
		.map(Number);
	return { recoveredErrors, unrecoveredErrors, unrecoveredRuns, meanCells };
}

function summary(stdout: string, condition: string) {
	const line = stdout.split("\n").find((line) => line.startsWith(`${condition} `));
	expect(line, `missing aggregate for ${condition}`).toBeDefined();
	const [runs, tasks, pass, tokensOut, tokensIn, cells, compileErrors, cellP50] = line!
		.slice(condition.length)
		.trim()
		.split(/\s+/);
	return {
		runs: Number(runs),
		tasks: Number(tasks),
		pass,
		tokensOut: Number(tokensOut),
		tokensIn: Number(tokensIn),
		cells: Number(cells),
		compileErrors,
		cellP50,
	};
}

describe("offline benchmark analyzer", () => {
	it.each([
		{ statuses: [], recovered: 0, unrecovered: 0, mean: null },
		{ statuses: ["ok"], recovered: 0, unrecovered: 0, mean: null },
		{ statuses: ["compile_error", "ok"], recovered: 1, unrecovered: 0, mean: 1 },
		{ statuses: ["compile_error", "compile_error", "ok"], recovered: 2, unrecovered: 0, mean: 1.5 },
		{ statuses: ["compile_error", "error", "timeout", "aborted", "ok"], recovered: 1, unrecovered: 0, mean: 4 },
		{ statuses: ["compile_error", "compile_error"], recovered: 0, unrecovered: 2, mean: null },
		{ statuses: ["compile_error", "ok", "compile_error"], recovered: 1, unrecovered: 1, mean: 1 },
		{
			statuses: ["compile_error", "ok", "ok", "compile_error", "error", "ok"],
			recovered: 2,
			unrecovered: 0,
			mean: 1.5,
		},
		{ statuses: ["error", "timeout", "aborted", "ok"], recovered: 0, unrecovered: 0, mean: null },
	])("reports compile-error recovery for $statuses", ({ statuses, recovered, unrecovered, mean }) => {
		const f = fixture();
		const { sessionFile } = f.add({ group: "F", tokensOut: 100 });
		writeRustCells(sessionFile, statuses);
		const { stdout, csv } = f.run();
		expect(csvRows(csv)[0]).toMatchObject({
			pass: "true",
			recoveredCompileErrors: String(recovered),
			unrecoveredCompileErrors: String(unrecovered),
			compileRecoveryMeanCells: mean === null ? "" : String(mean),
		});
		expect(recoverySummary(stdout, "fixture-model | F")).toEqual({
			recoveredErrors: recovered,
			unrecoveredErrors: unrecovered,
			unrecoveredRuns: unrecovered > 0 ? 1 : 0,
			meanCells: mean ?? Number.NaN,
		});
	});
	it("counts only Rust cells and follows recovery across turns within a run", () => {
		const f = fixture();
		const { sessionFile } = f.add({ group: "F", tokensOut: 100 });
		writeMessages(sessionFile, [
			{ role: "assistant", usage: { input: 0, output: 100 } },
			rustResult("compile_error"),
			{ role: "toolResult", toolName: "bash", isError: false },
			{ role: "toolResult", toolName: "ipython", details: { status: "ok" } },
			rustResult("compile_error"),
			{ role: "user", content: "Continue" },
			{ role: "assistant", usage: { input: 0, output: 100 } },
			rustResult("ok"),
		]);
		expect(recoverySummary(f.run().stdout, "fixture-model | F")).toEqual({
			recoveredErrors: 2,
			unrecoveredErrors: 0,
			unrecoveredRuns: 0,
			meanCells: 1.5,
		});
	});
	it("never closes an unrecovered error using a success from another run", () => {
		const f = fixture();
		for (const statuses of [["compile_error"], ["ok"]]) {
			const { sessionFile } = f.add({ group: "F", tokensOut: 100 });
			writeRustCells(sessionFile, statuses);
		}
		expect(recoverySummary(f.run().stdout, "fixture-model | F")).toEqual({
			recoveredErrors: 0,
			unrecoveredErrors: 1,
			unrecoveredRuns: 1,
			meanCells: Number.NaN,
		});
	});
	it("pools recovered-error distances and reports unrecovered errors alongside the mean", () => {
		const f = fixture();
		for (const statuses of [
			["compile_error", "compile_error", "ok"],
			["compile_error", "error", "error", "ok"],
			["compile_error", "compile_error"],
			["compile_error"],
		]) {
			const { sessionFile } = f.add({ group: "F", tokensOut: 100 });
			writeRustCells(sessionFile, statuses);
		}
		expect(recoverySummary(f.run().stdout, "fixture-model | F")).toEqual({
			recoveredErrors: 3,
			unrecoveredErrors: 3,
			unrecoveredRuns: 2,
			meanCells: 2,
		});
	});
	it.each([undefined, null, "starting", "running", "unknown", "ok"])(
		"withholds recovery metrics for ambiguous Rust status %s",
		(status) => {
			const f = fixture();
			f.add({ tokensOut: 100 });
			const complete = f.add({ group: "F", tokensOut: 100 });
			writeRustCells(complete.sessionFile, ["compile_error", "ok"]);
			const incomplete = f.add({ group: "F", tokensOut: 100 });
			writeMessages(incomplete.sessionFile, [
				{ role: "assistant", usage: { input: 0, output: 100 } },
				rustResult("compile_error"),
				rustResult(status, true),
				rustResult("ok"),
			]);
			const { stdout, csv } = f.run();
			expect(csvRows(csv).at(-1)).toMatchObject({
				recoveredCompileErrors: "",
				unrecoveredCompileErrors: "",
				compileRecoveryMeanCells: "",
			});
			expect(recoverySummary(stdout, "fixture-model | F")).toEqual({
				recoveredErrors: Number.NaN,
				unrecoveredErrors: Number.NaN,
				unrecoveredRuns: Number.NaN,
				meanCells: Number.NaN,
			});
			expect(stdout).toContain("fixture-model | F: pass 100% vs A 100% OK; tokensOut 100 vs A 100 OK → GO");
		},
	);
	it.each(
		["B", "F"].flatMap((group) =>
			[
				{ name: "disjoint", baseline: ["logs"], treatment: ["rename"] },
				{ name: "missing", baseline: ["logs", "rename"], treatment: ["logs"] },
				{ name: "extra", baseline: ["logs"], treatment: ["logs", "rename"] },
				{ name: "reweighted", baseline: ["logs", "logs", "rename"], treatment: ["logs", "rename", "rename"] },
			].map((example) => ({ group, ...example })),
		),
	)("withholds the $group verdict for $name task coverage", ({ group, baseline, treatment }) => {
		const f = fixture();
		for (const task of baseline) f.add({ task, tokensOut: 100 });
		for (const task of treatment) f.add({ task, group, tokensOut: 1 });
		const { stdout, csv } = f.run();
		const condition = `fixture-model | ${group}${group === "B" ? "/example" : ""}`;
		expect(stdout).toContain(`${condition}: task coverage differs — no verdict`);
		expect(stdout).not.toContain("→ GO");
		expect(stdout).not.toContain("→ NO-GO");
		// Keep all recorded runs visible, including tasks that have no counterpart.
		expect(csvRows(csv).map((row) => row.task)).toEqual([...baseline, ...treatment]);
	});
	it.each(["A", "F"].flatMap((group) => [undefined, null, 42, "", " "].map((task) => ({ group, task }))))(
		"withholds verdicts when $group has task ID $task",
		({ group, task }) => {
			const f = fixture();
			f.add({ tokensOut: 100 });
			f.add({ group: "F", tokensOut: 100 });
			const { metaPath } = f.add({ group, tokensOut: 100 });
			const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
			writeFileSync(metaPath, JSON.stringify({ ...meta, task }));
			const { stdout } = f.run();
			expect(summary(stdout, `fixture-model | ${group}`).tasks).toBeNaN();
			expect(stdout).toContain("fixture-model | F: task IDs incomplete — no verdict");
		},
	);
	it("reports tasks separately from runs and permits proportional repetition counts", () => {
		const f = fixture();
		for (const task of ["logs", "logs", "logs", "logs", "rename", "rename"]) f.add({ task, tokensOut: 100 });
		for (const task of ["rename", "logs", "logs"]) f.add({ task, group: "F", tokensOut: 100 });
		const { stdout } = f.run();
		expect(summary(stdout, "fixture-model | A")).toMatchObject({ tasks: 2, runs: 6 });
		expect(summary(stdout, "fixture-model | F")).toMatchObject({ tasks: 2, runs: 3 });
		expect(stdout).toContain("fixture-model | F: pass 100% vs A 100% OK; tokensOut 100 vs A 100 OK → GO");
	});
	it("allows both D17 prompt splits against a baseline with three repetitions per task", () => {
		const f = fixture();
		for (const task of ["logs", "rename"]) {
			for (let rep = 1; rep <= 3; rep++) {
				f.add({ task, tokensOut: 100 });
				f.add({ task, group: "B", variant: rep % 2 === 1 ? "example" : "noexample", tokensOut: 100 });
			}
		}
		const { stdout } = f.run();
		for (const [variant, runs] of [
			["example", 4],
			["noexample", 2],
		] as const) {
			expect(summary(stdout, `fixture-model | B/${variant}`)).toMatchObject({ tasks: 2, runs });
			expect(stdout).toContain(
				`fixture-model | B/${variant}: pass 100% vs A 100% OK; tokensOut 100 vs A 100 OK → GO`,
			);
		}
	});
	it("isolates task coverage by model and prompt variant", () => {
		const f = fixture();
		for (const task of ["logs", "rename"]) {
			f.add({ task, tokensOut: 100 });
			f.add({ task, group: "B", tokensOut: 100 });
			f.add({ task, model: "other-model", group: "B", variant: "noexample", tokensOut: 100 });
		}
		f.add({ task: "logs", group: "B", variant: "noexample", tokensOut: 100 });
		f.add({ task: "logs", model: "other-model", tokensOut: 100 });
		const { stdout } = f.run();
		expect(stdout).toContain("fixture-model | B/example: pass 100% vs A 100% OK; tokensOut 100 vs A 100 OK → GO");
		expect(stdout).toContain("fixture-model | B/noexample: task coverage differs — no verdict");
		expect(stdout).toContain("other-model | B/noexample: task coverage differs — no verdict");
	});
	it.each(
		["A", "F"].flatMap((group) =>
			["missing", "unreadable", "empty", "header-only", "malformed", "invalid message"].map((problem) => ({
				group,
				problem,
			})),
		),
	)("withholds transcript metrics and verdicts for $group with a $problem session", ({ group, problem }) => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		f.add({ group: "F", tokensOut: 100 });
		const { sessionFile } = f.add({ group, tokensOut: 100, durations: [10] });
		if (problem === "missing" || problem === "unreadable") {
			rmSync(sessionFile);
			if (problem === "unreadable") mkdirSync(sessionFile);
		} else if (problem === "empty") {
			writeFileSync(sessionFile, "\n");
		} else if (problem === "header-only") {
			writeFileSync(sessionFile, '{"type":"session","version":3}\n');
		} else {
			const badLine = problem === "malformed" ? '{"type":' : '{"type":"message","message":null}';
			writeFileSync(sessionFile, `${readFileSync(sessionFile, "utf-8")}\n${badLine}`);
		}
		const { stdout, csv } = f.run();
		const row = csvRows(csv).at(-1)!;
		expect(row.sessionStatus).toBe(
			problem === "header-only" ? "empty" : ["malformed", "invalid message"].includes(problem) ? "invalid" : problem,
		);
		for (const column of [
			"tokensIn",
			"tokensOut",
			"assistantTurns",
			"cellCount",
			"cellP50Ms",
			"errorToolResults",
			"recoveredCompileErrors",
			"unrecoveredCompileErrors",
			"compileRecoveryMeanCells",
		]) {
			expect(row[column], column).toBe("");
		}
		expect(recoverySummary(stdout, `fixture-model | ${group}`)).toEqual({
			recoveredErrors: Number.NaN,
			unrecoveredErrors: Number.NaN,
			unrecoveredRuns: Number.NaN,
			meanCells: Number.NaN,
		});
		const aggregate = summary(stdout, `fixture-model | ${group}`);
		expect(aggregate.tokensOut).toBeNaN();
		expect(aggregate.tokensIn).toBeNaN();
		expect(aggregate.cells).toBeNaN();
		expect(aggregate.compileErrors).toBe("n/a");
		expect(aggregate.cellP50).toBe("n/a");
		expect(stdout).toContain("fixture-model | F: output usage incomplete — no verdict");
		expect(stdout).not.toContain("→ GO");
	});
	it.each(["B", "F"])("does not drop an unmetered turn or run from the %s token median", (group) => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		f.add({ group, tokensOut: 100 });
		const { sessionFile } = f.add({ group, tokensOut: 100 });
		writeMessages(sessionFile, [
			{ role: "assistant", usage: { input: 10, output: 20 } },
			{ role: "assistant" },
			{ role: "assistant", usage: { input: 10, output: 20 } },
		]);
		const { stdout, csv } = f.run();
		expect(csvRows(csv).at(-1)).toMatchObject({
			sessionStatus: "ok",
			tokensOut: "",
			tokensIn: "",
			assistantTurns: "3",
		});
		const condition = `${group}${group === "B" ? "/example" : ""}`;
		expect(summary(stdout, `fixture-model | ${condition}`).tokensOut).toBeNaN();
		expect(stdout).toContain(`fixture-model | ${condition}: output usage incomplete — no verdict`);
	});
	it.each([undefined, null, "10", -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
		"does not interpret output usage %s as a token count",
		(output) => {
			const f = fixture();
			f.add({ tokensOut: 100 });
			const { sessionFile } = f.add({ group: "F", tokensOut: 100 });
			writeMessages(sessionFile, [{ role: "assistant", usage: { input: 10, output } }]);
			const { stdout, csv } = f.run();
			expect(csvRows(csv).at(-1)).toMatchObject({ tokensOut: "", tokensIn: "10" });
			expect(stdout).toContain("fixture-model | F: output usage incomplete — no verdict");
		},
	);
	it("marks token totals unavailable when addition exceeds safe integer precision", () => {
		const f = fixture();
		const { sessionFile } = f.add({ tokensOut: 1 });
		writeMessages(sessionFile, [
			{
				role: "assistant",
				usage: { input: Number.MAX_SAFE_INTEGER, cacheRead: 1, output: Number.MAX_SAFE_INTEGER },
			},
			{ role: "assistant", usage: { input: 0, output: 1 } },
		]);
		expect(csvRows(f.run().csv)[0]).toMatchObject({ tokensOut: "", tokensIn: "" });
	});
	it.each([
		{ usage: { output: 10 }, tokensIn: "" },
		{ usage: { input: 5, cacheRead: "5", output: 10 }, tokensIn: "" },
		{ usage: { input: 5, cacheWrite: null, output: 10 }, tokensIn: "" },
		{ usage: { input: 5, output: 10 }, tokensIn: "5" },
		{ usage: { input: 5, cacheRead: 10, cacheWrite: 20, output: 10 }, tokensIn: "35" },
	])("handles input usage independently of the output gate: $usage", ({ usage, tokensIn }) => {
		const f = fixture();
		f.add({ tokensOut: 10 });
		const { sessionFile } = f.add({ group: "F", tokensOut: 10 });
		writeMessages(sessionFile, [{ role: "assistant", usage }]);
		const { stdout, csv } = f.run();
		expect(csvRows(csv).at(-1)).toMatchObject({ tokensOut: "10", tokensIn });
		if (tokensIn === "") expect(summary(stdout, "fixture-model | F").tokensIn).toBeNaN();
		expect(stdout).toContain("fixture-model | F: pass 100% vs A 100% OK; tokensOut 10 vs A 10 OK → GO");
	});
	it.each(["A", "F"].flatMap((group) => [null, undefined, "false"].map((checkPass) => ({ group, checkPass }))))(
		"does not exclude an unscored $group run with checkPass=$checkPass",
		({ group, checkPass }) => {
			const f = fixture();
			f.add({ tokensOut: 100 });
			f.add({ group: "F", tokensOut: 100 });
			const { metaPath } = f.add({ group, tokensOut: 100 });
			const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
			writeFileSync(metaPath, JSON.stringify({ ...meta, checkPass }));
			const { stdout, csv } = f.run();
			expect(csvRows(csv).at(-1)?.pass).toBe("");
			expect(summary(stdout, `fixture-model | ${group}`).pass).toBe("n/a");
			expect(stdout).toContain("fixture-model | F: checks incomplete — no verdict");
		},
	);
	it.each([
		{ values: [7], median: 7 },
		{ values: [9, 2, 1], median: 2 },
		{ values: [9, 1, 2, 8], median: 5 },
		{ values: [0, 3], median: 1.5 },
		{ values: [4, 4, 4, 4], median: 4 },
	])("uses sample medians for $values", ({ values, median }) => {
		const f = fixture();
		for (const value of values) f.add({ tokensOut: value, tokensIn: value * 10, durations: Array(value).fill(1) });
		expect(summary(f.run().stdout, "fixture-model | A")).toMatchObject({
			runs: values.length,
			tokensOut: median,
			tokensIn: median * 10,
			cells: median,
		});
	});
	it("preserves the cell percentile convention in the CSV and pooled aggregate", () => {
		const f = fixture();
		f.add({ tokensOut: 1, durations: [1, 9] });
		f.add({ tokensOut: 3, durations: [2, 100] });
		f.add({ tokensOut: 5 });
		const result = f.run();
		expect(summary(result.stdout, "fixture-model | A").cellP50).toBe("9ms");
		const rows = result.csv
			.split("\n")
			.slice(1)
			.map((line) => line.split(","));
		expect(rows.map((row) => row.slice(15, 17))).toEqual([
			["9", "9"],
			["100", "100"],
			["0", "0"],
		]);
	});
	it.each(["B", "F"])("evaluates the %s token gate with sample medians", (group) => {
		const f = fixture();
		for (const tokensOut of [1, 100]) f.add({ tokensOut });
		for (const tokensOut of [150, 180]) f.add({ group, tokensOut });
		const condition = `fixture-model | ${group}${group === "B" ? "/example" : ""}`;
		expect(f.run().stdout).toContain(`  ${condition}: pass 100% vs A 100% OK; tokensOut 165 vs A 50.5 MISS → NO-GO`);
	});
	it("keeps B prompt variants separate and includes the F condition", () => {
		const f = fixture();
		for (const tokensOut of [90, 100]) f.add({ tokensOut });
		for (const group of ["B", "F"]) {
			for (const tokensOut of [1, 201]) f.add({ group, tokensOut });
		}
		f.add({ group: "B", variant: "noexample", tokensOut: 300 });
		const { stdout } = f.run();
		for (const condition of ["B/example", "F"]) {
			expect(stdout).toContain(
				`  fixture-model | ${condition}: pass 100% vs A 100% OK; tokensOut 101 vs A 95 OK → GO`,
			);
		}
		expect(stdout).toContain(
			"  fixture-model | B/noexample: pass 100% vs A 100% OK; tokensOut 300 vs A 95 MISS → NO-GO",
		);
	});
	it.each(["B", "F"])("requires a same-model baseline and a passing task rate for %s", (group) => {
		const f = fixture();
		f.add({ model: "other-model", group, tokensOut: 1 });
		f.add({ tokensOut: 100 });
		f.add({ group, tokensOut: 1, pass: false });
		const condition = `${group}${group === "B" ? "/example" : ""}`;
		const { stdout } = f.run();
		expect(stdout).toContain(`  other-model | ${condition}: baseline incomplete — no verdict`);
		expect(stdout).toContain(
			`  fixture-model | ${condition}: pass 0% vs A 100% MISS; tokensOut 1 vs A 100 OK → NO-GO`,
		);
	});
	it.each(["B", "F"])("does not waive the %s token limit when the baseline median is zero", (group) => {
		const condition = `${group}${group === "B" ? "/example" : ""}`;
		for (const tokensOut of [0, 1]) {
			const f = fixture();
			f.add({ tokensOut: 0 });
			f.add({ group, tokensOut });
			expect(f.run().stdout).toContain(
				`  fixture-model | ${condition}: pass 100% vs A 100% OK; tokensOut ${tokensOut} vs A 0 ${tokensOut === 0 ? "OK → GO" : "MISS → NO-GO"}`,
			);
		}
	});
	it("reproduces the corrected August 10 token medians from the committed per-run totals", () => {
		const f = fixture();
		const [header, ...lines] = readFileSync(join(repo, "docs/benchmark-comparison-2026-08-10.csv"), "utf-8")
			.trim()
			.split("\n");
		const columns = header.split(",");
		for (const line of lines) {
			const row = Object.fromEntries(line.split(",").map((value, index) => [columns[index], value]));
			// The CSV retains token totals, not individual cell durations.
			f.add({
				task: row.task,
				model: row.model,
				group: row.group,
				tokensOut: Number(row.tokensOut),
				tokensIn: Number(row.tokensIn),
				pass: row.pass === "true",
			});
		}
		const { stdout } = f.run();
		for (const [model, group, median] of [
			["claude-opus-5", "A", 427.5],
			["claude-opus-5", "F", 755.5],
			["claude-sonnet-4-6", "A", 767.5],
			["claude-sonnet-4-6", "F", 1186],
		] as const) {
			expect(summary(stdout, `gateway/anthropic/${model} | ${group}`)).toMatchObject({
				tasks: 12,
				runs: 36,
				tokensOut: median,
			});
		}
		expect(stdout).toContain(
			"  gateway/anthropic/claude-opus-5 | F: pass 100% vs A 100% OK; tokensOut 755.5 vs A 427.5 OK → GO",
		);
		expect(stdout).toContain(
			"  gateway/anthropic/claude-sonnet-4-6 | F: pass 100% vs A 92% OK; tokensOut 1186 vs A 767.5 OK → GO",
		);
	});
});
