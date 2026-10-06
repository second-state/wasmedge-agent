import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CELL_PHASES } from "../src/core/rust-cell/cell-timing.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function details(cargoMs: number) {
	return {
		status: "ok",
		durationMs: cargoMs,
		timings: {
			version: 1,
			queueMs: 2,
			...Object.fromEntries(CELL_PHASES.map((key) => [key, key === "cargoMs" ? cargoMs : 0])),
		},
		toolTiming: { provisionMs: 3, totalMs: cargoMs + 5 },
	};
}
function analyze(records: { cells: unknown[]; driverStatus?: string; invalidSession?: boolean }[]) {
	const root = mkdtempSync(join(tmpdir(), "benchmark-timing-"));
	roots.push(root);
	for (const file of ["analyze.ts", "launchers.ts", "source-inputs.ts"])
		copyFileSync(resolve(__dirname, "../../../poc/bench", file), join(root, file));
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	for (const [i, record] of records.entries()) {
		const dir = join(root, "results/runs", String(i));
		mkdirSync(dir, { recursive: true });
		const sessionFile = join(dir, "session.jsonl");
		const messages = [
			{ role: "assistant", usage: { input: 0, output: 1 } },
			...record.cells.map((cell) => ({ role: "toolResult", toolName: "rust", details: cell })),
		];
		writeFileSync(
			sessionFile,
			messages.map((message) => JSON.stringify({ type: "message", message })).join("\n") +
				(record.invalidSession ? "\ninvalid" : ""),
		);
		writeFileSync(
			join(dir, "meta.json"),
			JSON.stringify({
				runId: String(i),
				task: "fixture",
				category: "fixture",
				model: "fixture",
				group: "F",
				variant: "builtin",
				rep: i + 1,
				checkPass: true,
				driverStatus: record.driverStatus ?? "completed",
				sessionFile,
			}),
		);
	}
	const csv = join(root, "metrics.csv");
	const stdout = execFileSync(
		process.execPath,
		["--experimental-strip-types", join(root, "analyze.ts"), "--csv", csv],
		{ encoding: "utf8" },
	);
	const [header, ...rows] = readFileSync(csv, "utf8").split("\n");
	const columns = header.split(",");
	return {
		stdout,
		rows: rows.map((line) => Object.fromEntries(line.split(",").map((value, i) => [columns[i], value]))),
	};
}

describe("benchmark phase timing evidence", () => {
	it("pools all statuses across runs and retains the documented percentile convention", () => {
		const result = analyze([
			{ cells: [details(0.25), { ...details(2), status: "compile_error" }] },
			{ cells: [details(100)] },
			{ cells: [] },
		]);
		expect(result.rows[0]).toMatchObject({
			rustCellCount: "2",
			timedRustCells: "2",
			toolTimedRustCells: "2",
			cargoP50Ms: "2",
			cargoP95Ms: "2",
			toolTotalP50Ms: "7",
			executionP50Ms: "0",
		});
		expect(result.stdout).toMatch(/cargoMs\s+p50=2 p95=100/);
		expect(result.stdout).toContain("runner coverage 3/3; tool coverage 3/3");
		expect(result.rows[2].cargoP50Ms).toBe("");
	});

	it.each(["missing", "negative", "string", "version", "sum", "tool"])(
		"does not manufacture timing for %s evidence",
		(kind) => {
			const invalid = JSON.parse(JSON.stringify(details(10)));
			if (kind === "missing") delete invalid.timings;
			if (kind === "negative") invalid.timings.cargoMs = -1;
			if (kind === "string") invalid.timings.cargoMs = "10";
			if (kind === "version") invalid.timings.version = 2;
			if (kind === "sum") invalid.timings.cargoMs = 20;
			if (kind === "tool") invalid.toolTiming.totalMs = 1;
			const result = analyze([{ cells: [details(1), invalid] }]);
			expect(result.rows[0].toolTotalP50Ms).toBe("");
			expect(result.rows[0].cargoP50Ms).toBe(kind === "tool" ? "10" : "");
			expect(result.rows[0].timedRustCells).toBe(kind === "tool" ? "2" : "1");
			expect(result.stdout).toMatch(/toolTotalMs\s+p50=n\/a p95=n\/a/);
		},
	);

	it.each(["invalidSession", "incomplete"])("withholds condition timing for %s records", (kind) => {
		const result = analyze([
			{ cells: [details(1)] },
			{
				cells: [details(10)],
				invalidSession: kind === "invalidSession",
				driverStatus: kind === "incomplete" ? "running" : "completed",
			},
		]);
		expect(result.stdout).toMatch(/cargoMs\s+p50=n\/a p95=n\/a/);
		expect(result.rows[1].cargoP50Ms).toBe(kind === "invalidSession" ? "" : "10");
	});
});
