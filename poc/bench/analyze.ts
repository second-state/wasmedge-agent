/**
 * Offline metrics extraction (DESIGN.md §6.3): walks results/runs/<id>/meta.json
 * plus each run's session JSONL and emits a per-run CSV and per-condition
 * aggregates, checked against the D20 GO/NO-GO thresholds.
 *
 *   node poc/bench/analyze.ts [--csv results/bench.csv]
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "results", "runs");

type SessionStatus = "ok" | "missing" | "unreadable" | "invalid" | "empty";

interface RunMetrics {
	runId: string;
	task: string;
	category: string;
	group: string;
	model: string;
	variant: string;
	rep: number;
	pass: boolean | null;
	timedOut: boolean;
	wallMs: number;
	sessionStatus: SessionStatus;
	tokensIn: number | null;
	tokensOut: number | null;
	assistantTurns: number;
	toolCalls: Record<string, number>;
	errorToolResults: number;
	cellCount: number;
	compileErrorCells: number;
	cellDurationsMs: number[];
	compileMsTotal: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addTokens(total: number | null, ...counts: unknown[]): number | null {
	if (total === null) return null;
	for (const count of counts) {
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
		total += count;
		if (!Number.isSafeInteger(total)) return null;
	}
	return total;
}

function analyzeSession(sessionFile: string, metrics: RunMetrics): SessionStatus {
	let source: string;
	try {
		source = readFileSync(sessionFile, "utf-8");
	} catch (error) {
		return isRecord(error) && error.code === "ENOENT" ? "missing" : "unreadable";
	}
	metrics.tokensIn = 0;
	metrics.tokensOut = 0;
	const lines = source.split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			return "invalid";
		}
		if (!isRecord(entry) || typeof entry.type !== "string") return "invalid";
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || typeof message.role !== "string") return "invalid";

		if (message.role === "assistant") {
			metrics.assistantTurns += 1;
			const usage = isRecord(message.usage) ? message.usage : {};
			metrics.tokensIn = addTokens(
				metrics.tokensIn,
				usage.input,
				usage.cacheRead === undefined ? 0 : usage.cacheRead,
				usage.cacheWrite === undefined ? 0 : usage.cacheWrite,
			);
			metrics.tokensOut = addTokens(metrics.tokensOut, usage.output);
			if (message.content !== undefined && !Array.isArray(message.content)) return "invalid";
			for (const block of message.content ?? []) {
				if (!isRecord(block) || typeof block.type !== "string") return "invalid";
				if (block.type === "toolCall") {
					const name = typeof block.name === "string" ? block.name : "unknown";
					metrics.toolCalls[name] = (metrics.toolCalls[name] ?? 0) + 1;
				}
			}
		}

		if (message.role === "toolResult") {
			if (message.isError) metrics.errorToolResults += 1;
			const details = isRecord(message.details) ? message.details : {};
			const toolName = message.toolName;
			if (toolName === "rust" || toolName === "ipython") {
				metrics.cellCount += 1;
				if (typeof details?.durationMs === "number") {
					metrics.cellDurationsMs.push(details.durationMs);
				}
				if (details?.status === "compile_error") metrics.compileErrorCells += 1;
				if (typeof details?.compileMs === "number") metrics.compileMsTotal += details.compileMs;
			}
		}
	}
	return metrics.assistantTurns ? "ok" : "empty";
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

function median(values: (number | null)[]): number | null {
	if (values.length === 0 || !values.every((value): value is number => value !== null)) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Find meta.json up to depth 3 (tolerates the pre-fix nested "n/a" dirs). */
function findMetaFiles(dir: string, depth = 0): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (name === "meta.json") out.push(path);
		else if (depth < 3) {
			try {
				if (statSync(path).isDirectory() && !["project", "agent-dir", "workspaces"].includes(name)) {
					out.push(...findMetaFiles(path, depth + 1));
				}
			} catch {
				// unreadable entry: skip
			}
		}
	}
	return out;
}

const runs: RunMetrics[] = [];
if (!existsSync(RUNS_DIR)) {
	console.error(`no runs at ${RUNS_DIR}`);
	process.exit(1);
}
for (const metaPath of findMetaFiles(RUNS_DIR)) {
	const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
	const m: RunMetrics = {
		runId: meta.runId,
		task: meta.task,
		category: meta.category,
		group: meta.group,
		model: meta.model,
		variant: meta.variant,
		rep: meta.rep,
		pass: typeof meta.checkPass === "boolean" ? meta.checkPass : null,
		timedOut: meta.timedOut,
		wallMs: meta.wallMs,
		sessionStatus: "missing",
		tokensIn: null,
		tokensOut: null,
		assistantTurns: 0,
		toolCalls: {},
		errorToolResults: 0,
		cellCount: 0,
		compileErrorCells: 0,
		cellDurationsMs: [],
		compileMsTotal: 0,
	};
	if (typeof meta.sessionFile === "string" && meta.sessionFile) m.sessionStatus = analyzeSession(meta.sessionFile, m);
	if (m.sessionStatus !== "ok") {
		m.tokensIn = null;
		m.tokensOut = null;
	}
	runs.push(m);
}

// Per-run CSV
const csvPath =
	process.argv.includes("--csv") && process.argv[process.argv.indexOf("--csv") + 1]
		? resolve(process.argv[process.argv.indexOf("--csv") + 1])
		: join(HERE, "results", "bench.csv");
const header =
	"runId,task,category,group,model,variant,rep,pass,timedOut,wallMs,tokensIn,tokensOut,assistantTurns,cellCount,compileErrorCells,cellP50Ms,cellP95Ms,errorToolResults,sessionStatus";
const rows = runs.map((m) => {
	const hasSession = m.sessionStatus === "ok";
	return [
		m.runId,
		m.task,
		m.category,
		m.group,
		m.model,
		m.variant,
		m.rep,
		m.pass,
		m.timedOut,
		m.wallMs,
		m.tokensIn,
		m.tokensOut,
		hasSession ? m.assistantTurns : null,
		hasSession ? m.cellCount : null,
		hasSession ? m.compileErrorCells : null,
		hasSession ? percentile(m.cellDurationsMs, 50) : null,
		hasSession ? percentile(m.cellDurationsMs, 95) : null,
		hasSession ? m.errorToolResults : null,
		m.sessionStatus,
	].join(",");
});
writeFileSync(csvPath, [header, ...rows].join("\n"));
console.log(`wrote ${runs.length} run(s) → ${csvPath}\n`);

// Aggregates per (model, group)
interface Agg {
	runs: number;
	passRate: number | null;
	tokensOutMedian: number | null;
	tokensInMedian: number | null;
	cellsMedian: number | null;
	compileErrorShare: number | null;
	cellP50: number | null;
}
const byCondition = new Map<string, RunMetrics[]>();
for (const m of runs) {
	const key = `${m.model} | ${m.group}${m.group === "B" ? `/${m.variant}` : ""}`;
	byCondition.set(key, [...(byCondition.get(key) ?? []), m]);
}
const aggs = new Map<string, Agg>();
for (const [key, ms] of byCondition) {
	const scored = ms.filter((m) => m.pass !== null);
	const hasSessions = ms.every((m) => m.sessionStatus === "ok");
	const allCells = ms.flatMap((m) => m.cellDurationsMs);
	const totalCells = ms.reduce((sum, m) => sum + m.cellCount, 0);
	aggs.set(key, {
		runs: ms.length,
		passRate: scored.length === ms.length ? scored.filter((m) => m.pass).length / ms.length : null,
		tokensOutMedian: median(ms.map((m) => m.tokensOut)),
		tokensInMedian: median(ms.map((m) => m.tokensIn)),
		cellsMedian: hasSessions ? median(ms.map((m) => m.cellCount)) : null,
		compileErrorShare: hasSessions ? (totalCells ? ms.reduce((s, m) => s + m.compileErrorCells, 0) / totalCells : 0) : null,
		cellP50: hasSessions ? percentile(allCells, 50) : null,
	});
}

console.log("med = sample median; cell p50/p95 = sorted[floor(n × p / 100)], capped at the last value.");
console.log("n/a = unavailable: at least one run has missing or invalid evidence for that metric (blank in CSV).");
console.log("condition                                                    runs  pass%  tokOut(med)  tokIn(med)  cells(med)  cErr%  cellP50");
for (const [key, a] of [...aggs.entries()].sort()) {
	const pass = a.passRate === null ? "n/a" : `${Math.round(a.passRate * 100)}%`;
	const compileErrors = a.compileErrorShare === null ? "n/a" : `${Math.round(a.compileErrorShare * 100)}%`;
	console.log(
		[
			key.padEnd(60),
			String(a.runs).padStart(4),
			pass.padStart(5),
			String(a.tokensOutMedian ?? "n/a").padStart(11),
			String(a.tokensInMedian ?? "n/a").padStart(10),
			String(a.cellsMedian ?? "n/a").padStart(10),
			compileErrors.padStart(5),
			a.cellP50 === null ? "n/a" : `${a.cellP50}ms`,
		].join("  "),
	);
}

// D20 gate: compare each B/F condition against the same-model A condition.
console.log("\nD20 gate (per model): pass ≥ A−15pp, median output tokens ≤ 2.0×A");
for (const [key, b] of aggs) {
	const [model, condition] = key.split(" | ");
	if (condition !== "F" && !condition.startsWith("B/")) continue;
	const a = aggs.get(`${model} | A`);
	if (!a) {
		console.log(`  ${key}: baseline incomplete — no verdict`);
		continue;
	}
	if (a.passRate === null || b.passRate === null) {
		console.log(`  ${key}: checks incomplete — no verdict`);
		continue;
	}
	if (a.tokensOutMedian === null || b.tokensOutMedian === null) {
		console.log(`  ${key}: output usage incomplete — no verdict`);
		continue;
	}
	const passOk = b.passRate >= a.passRate - 0.15;
	const tokOk = b.tokensOutMedian <= 2.0 * a.tokensOutMedian;
	console.log(
		`  ${key}: pass ${Math.round(b.passRate * 100)}% vs A ${Math.round(a.passRate * 100)}% ${passOk ? "OK" : "MISS"}; tokensOut ${b.tokensOutMedian} vs A ${a.tokensOutMedian} ${tokOk ? "OK" : "MISS"} → ${passOk && tokOk ? "GO" : "NO-GO"}`,
	);
}
