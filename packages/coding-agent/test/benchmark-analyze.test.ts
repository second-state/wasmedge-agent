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
			model = "fixture-model",
			group = "A",
			variant = "example",
			tokensOut,
			tokensIn = 0,
			durations = [],
			pass = true,
		}: {
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
					task: "fixture",
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

function summary(stdout: string, condition: string) {
	const line = stdout.split("\n").find((line) => line.startsWith(`${condition} `));
	expect(line, `missing aggregate for ${condition}`).toBeDefined();
	const [runs, pass, tokensOut, tokensIn, cells, compileErrors, cellP50] = line!
		.slice(condition.length)
		.trim()
		.split(/\s+/);
	return {
		runs: Number(runs),
		pass,
		tokensOut: Number(tokensOut),
		tokensIn: Number(tokensIn),
		cells: Number(cells),
		compileErrors,
		cellP50,
	};
}

describe("offline benchmark analyzer", () => {
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
		for (const column of ["tokensIn", "tokensOut", "assistantTurns", "cellCount", "cellP50Ms", "errorToolResults"]) {
			expect(row[column], column).toBe("");
		}
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
