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
type DriverStatus = "legacy" | "planned" | "running" | "completed" | "error" | "invalid";

interface CompileRecovery {
	recoveredErrors: number;
	unrecoveredErrors: number;
	distanceTotal: number;
}

interface RunMetrics {
	runId: string;
	task: string;
	taskHash: string | null;
	category: string;
	group: string;
	model: string;
	variant: string;
	rep: number;
	pass: boolean | null;
	timedOut: boolean;
	wallMs: number | null;
	driverStatus: DriverStatus;
	sessionStatus: SessionStatus;
	tokensIn: number | null;
	tokensOut: number | null;
	assistantTurns: number;
	toolCalls: Record<string, number>;
	errorToolResults: number;
	cellCount: number;
	compileErrorCells: number;
	cellDurationsMs: number[] | null;
	compileMsTotal: number;
	compileRecovery: CompileRecovery | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function driverStatus(value: unknown): DriverStatus {
	if (value === undefined) return "legacy";
	if (value === "planned" || value === "running" || value === "completed" || value === "error") return value;
	return "invalid";
}

function driverComplete(metrics: RunMetrics): boolean {
	return metrics.driverStatus === "legacy" || metrics.driverStatus === "completed";
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
	const recovery: CompileRecovery = { recoveredErrors: 0, unrecoveredErrors: 0, distanceTotal: 0 };
	const pendingErrors: number[] = [];
	let rustCellIndex = 0;
	let recoveryComplete = true;
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
				const duration = details.durationMs;
				if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
					metrics.cellDurationsMs?.push(duration);
				} else {
					metrics.cellDurationsMs = null;
				}
				if (details?.status === "compile_error") metrics.compileErrorCells += 1;
				if (typeof details?.compileMs === "number") metrics.compileMsTotal += details.compileMs;
			}
			if (toolName === "rust") {
				rustCellIndex += 1;
				const status = details.status;
				if (
					typeof status !== "string" ||
					!["ok", "compile_error", "error", "timeout", "aborted"].includes(status) ||
					(message.isError !== undefined && message.isError !== (status !== "ok"))
				) {
					recoveryComplete = false;
				} else if (status === "compile_error") {
					pendingErrors.push(rustCellIndex);
				} else if (status === "ok") {
					for (const errorIndex of pendingErrors) recovery.distanceTotal += rustCellIndex - errorIndex;
					recovery.recoveredErrors += pendingErrors.length;
					pendingErrors.length = 0;
				}
			}
		}
	}
	if (!metrics.assistantTurns) return "empty";
	recovery.unrecoveredErrors = pendingErrors.length;
	metrics.compileRecovery = recoveryComplete ? recovery : null;
	return "ok";
}

function compileRecoveryMean(recovery: CompileRecovery | null): number | null {
	return recovery && recovery.recoveredErrors > 0 ? recovery.distanceTotal / recovery.recoveredErrors : null;
}

function percentile(values: number[] | null, p: number): number | null {
	if (!values?.length) return null;
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
				if (statSync(path).isDirectory() && !["project", "agent-dir", "workspaces", "task"].includes(name)) {
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
		taskHash: typeof meta.taskHash === "string" && /^sha256:[a-f0-9]{64}$/.test(meta.taskHash) ? meta.taskHash : null,
		category: meta.category,
		group: meta.group,
		model: meta.model,
		variant: meta.variant,
		rep: meta.rep,
		pass: typeof meta.checkPass === "boolean" ? meta.checkPass : null,
		timedOut: meta.timedOut,
		wallMs: meta.wallMs,
		driverStatus: driverStatus(meta.driverStatus),
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
		compileRecovery: null,
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
	"runId,task,category,group,model,variant,rep,pass,timedOut,wallMs,tokensIn,tokensOut,assistantTurns,cellCount,compileErrorCells,cellP50Ms,cellP95Ms,errorToolResults,sessionStatus,recoveredCompileErrors,unrecoveredCompileErrors,compileRecoveryMeanCells,driverStatus,taskHash";
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
		m.compileRecovery?.recoveredErrors,
		m.compileRecovery?.unrecoveredErrors,
		compileRecoveryMean(m.compileRecovery),
		m.driverStatus,
		m.taskHash,
	].join(",");
});
writeFileSync(csvPath, [header, ...rows].join("\n"));
console.log(`wrote ${runs.length} run(s) → ${csvPath}\n`);

// Aggregates per (model, group)
interface Agg {
	runs: number;
	taskCounts: Map<string, number> | null;
	taskVersions: Map<string, string> | null;
	passRate: number | null;
	tokensOutMedian: number | null;
	tokensInMedian: number | null;
	cellsMedian: number | null;
	compileErrorShare: number | null;
	cellP50: number | null;
	compileRecovery: CompileRecovery | null;
	unrecoveredRuns: number | null;
	driverIncompleteRuns: number;
}

function countTasks(metrics: RunMetrics[]): Map<string, number> | null {
	const counts = new Map<string, number>();
	for (const { task } of metrics) {
		if (typeof task !== "string" || !task.trim()) return null;
		counts.set(task, (counts.get(task) ?? 0) + 1);
	}
	return counts;
}

function taskVersions(metrics: RunMetrics[]): Map<string, string> | null {
	const versions = new Map<string, string>();
	for (const { task, taskHash } of metrics) {
		if (taskHash === null || (versions.has(task) && versions.get(task) !== taskHash)) return null;
		versions.set(task, taskHash);
	}
	return versions;
}

const byCondition = new Map<string, RunMetrics[]>();
function conditionFor(metrics: RunMetrics): string {
	return `${metrics.group}${metrics.group === "B" ? `/${metrics.variant}` : ""}`;
}

function isTreatment(condition: string): boolean {
	return condition === "F" || condition.startsWith("B/");
}

for (const m of runs) {
	const key = `${m.model} | ${conditionFor(m)}`;
	byCondition.set(key, [...(byCondition.get(key) ?? []), m]);
}
const aggs = new Map<string, Agg>();
for (const [key, ms] of byCondition) {
	const scored = ms.filter((m) => m.pass !== null);
	const driverIncompleteRuns = ms.filter((m) => !driverComplete(m)).length;
	const complete = driverIncompleteRuns === 0;
	const hasSessions = complete && ms.every((m) => m.sessionStatus === "ok");
	const durations = ms.map((m) => m.cellDurationsMs);
	const allCells = durations.every((values): values is number[] => values !== null) ? durations.flat() : null;
	const totalCells = ms.reduce((sum, m) => sum + m.cellCount, 0);
	const recoveries = ms.map((m) => m.compileRecovery);
	let compileRecovery: CompileRecovery | null = null;
	let unrecoveredRuns: number | null = null;
	if (complete && recoveries.every((r): r is CompileRecovery => r !== null)) {
		compileRecovery = { recoveredErrors: 0, unrecoveredErrors: 0, distanceTotal: 0 };
		unrecoveredRuns = 0;
		for (const recovery of recoveries) {
			compileRecovery.recoveredErrors += recovery.recoveredErrors;
			compileRecovery.unrecoveredErrors += recovery.unrecoveredErrors;
			compileRecovery.distanceTotal += recovery.distanceTotal;
			if (recovery.unrecoveredErrors > 0) unrecoveredRuns += 1;
		}
	}
	aggs.set(key, {
		runs: ms.length,
		taskCounts: countTasks(ms),
		taskVersions: taskVersions(ms),
		passRate: complete && scored.length === ms.length ? scored.filter((m) => m.pass).length / ms.length : null,
		tokensOutMedian: complete ? median(ms.map((m) => m.tokensOut)) : null,
		tokensInMedian: complete ? median(ms.map((m) => m.tokensIn)) : null,
		cellsMedian: hasSessions ? median(ms.map((m) => m.cellCount)) : null,
		compileErrorShare: hasSessions ? (totalCells ? ms.reduce((s, m) => s + m.compileErrorCells, 0) / totalCells : 0) : null,
		cellP50: hasSessions ? percentile(allCells, 50) : null,
		compileRecovery,
		unrecoveredRuns,
		driverIncompleteRuns,
	});
}

console.log("med = sample median; cell p50/p95 = sorted[floor(n × p / 100)], capped at the last value.");
console.log("tasks = distinct task IDs; runs = registered repetitions, including planned runs that have not started.");
console.log("n/a = unavailable: missing or invalid evidence for that metric, or no samples (blank in CSV).");
console.log("condition                                                    runs  tasks  pass%  tokOut(med)  tokIn(med)  cells(med)  cErr%  cellP50  driverIncomplete");
for (const [key, a] of [...aggs.entries()].sort()) {
	const pass = a.passRate === null ? "n/a" : `${Math.round(a.passRate * 100)}%`;
	const compileErrors = a.compileErrorShare === null ? "n/a" : `${Math.round(a.compileErrorShare * 100)}%`;
	console.log(
		[
			key.padEnd(60),
			String(a.runs).padStart(4),
			String(a.taskCounts?.size ?? "n/a").padStart(5),
			pass.padStart(5),
			String(a.tokensOutMedian ?? "n/a").padStart(11),
			String(a.tokensInMedian ?? "n/a").padStart(10),
			String(a.cellsMedian ?? "n/a").padStart(10),
			compileErrors.padStart(5),
			a.cellP50 === null ? "n/a" : `${a.cellP50}ms`,
			String(a.driverIncompleteRuns),
		].join("  "),
	);
}

console.log("\nCompile-error recovery (Rust cells):");
console.log("meanCells averages Rust-cell distances to the next success in the same run; unrecovered errors are separate.");
console.log("condition                                                     recoveredErrors  unrecoveredErrors  unrecoveredRuns  meanCells");
for (const [key, a] of [...aggs.entries()].sort()) {
	console.log(
		[
			key.padEnd(60),
			String(a.compileRecovery?.recoveredErrors ?? "n/a").padStart(15),
			String(a.compileRecovery?.unrecoveredErrors ?? "n/a").padStart(17),
			String(a.unrecoveredRuns ?? "n/a").padStart(15),
			compileRecoveryMean(a.compileRecovery)?.toFixed(2) ?? "n/a",
		].join("  "),
	);
}

function sameTaskCoverage(a: Agg, b: Agg): boolean {
	// Compare relative task weights so D17 prompt splits can use fewer repetitions.
	return (
		a.taskCounts !== null && b.taskCounts !== null &&
		a.taskCounts.size === b.taskCounts.size &&
		[...a.taskCounts].every(([task, count]) => count * b.runs === (b.taskCounts?.get(task) ?? 0) * a.runs)
	);
}

function sameTaskVersions(a: Agg, b: Agg): boolean {
	return (
		a.taskVersions !== null && b.taskVersions !== null &&
		a.taskVersions.size === b.taskVersions.size &&
		[...a.taskVersions].every(([task, hash]) => b.taskVersions?.get(task) === hash)
	);
}

interface GateResult {
	verdict: "GO" | "NO-GO" | null;
	message: string;
}

function noVerdict(reason: string): GateResult {
	return { verdict: null, message: `${reason} — no verdict` };
}

function d20Gate(a: Agg | undefined, b: Agg | undefined): GateResult {
	if (!a) return noVerdict("baseline incomplete");
	if (!b) return noVerdict("treatment incomplete");
	if (a.driverIncompleteRuns || b.driverIncompleteRuns) return noVerdict("driver runs incomplete");
	if (!a.taskCounts || !b.taskCounts) return noVerdict("task IDs incomplete");
	if (!sameTaskCoverage(a, b)) return noVerdict("task coverage differs");
	if (!a.taskVersions || !b.taskVersions) return noVerdict("task versions incomplete or inconsistent");
	if (!sameTaskVersions(a, b)) return noVerdict("task versions differ");
	if (a.passRate === null || b.passRate === null) return noVerdict("checks incomplete");
	if (a.tokensOutMedian === null || b.tokensOutMedian === null) return noVerdict("output usage incomplete");
	const passOk = b.passRate >= a.passRate - 0.15;
	const tokOk = b.tokensOutMedian <= 2.0 * a.tokensOutMedian;
	const verdict = passOk && tokOk ? "GO" : "NO-GO";
	return {
		verdict,
		message: `pass ${Math.round(b.passRate * 100)}% vs A ${Math.round(a.passRate * 100)}% ${passOk ? "OK" : "MISS"}; tokensOut ${b.tokensOutMedian} vs A ${a.tokensOutMedian} ${tokOk ? "OK" : "MISS"} → ${verdict}`,
	};
}

// D20 gate: compare each B/F condition against the same-model A condition.
console.log("\nD20 gate (per model): pass ≥ A−15pp, median output tokens ≤ 2.0×A");
for (const [key, b] of aggs) {
	const [model, condition] = key.split(" | ");
	if (!isTreatment(condition)) continue;
	console.log(`  ${key}: ${d20Gate(aggs.get(`${model} | A`), b).message}`);
}

console.log("\nD20 overall (per treatment): at least 2 distinct model IDs must meet both thresholds");
console.log("All recorded models need complete comparisons on the same task versions and relative task weights.");
const treatments = [...new Set(runs.map(conditionFor).filter(isTreatment))].sort();
if (treatments.length === 0) console.log("  no treatment conditions — no verdict");
for (const condition of treatments) {
	if (!["F", "B/example", "B/noexample"].includes(condition)) {
		console.log(`  ${condition}: treatment variant incomplete or invalid — no verdict`);
		continue;
	}
	// Include baseline-only models so absent treatment records cannot disappear
	// from the overall decision. B variants and F never pool their passing models.
	const records = runs.filter((run) => run.group === "A" || conditionFor(run) === condition);
	if (records.some(({ model }) =>
		typeof model !== "string" || !model.trim() || model !== model.trim() || model.includes(" | "),
	)) {
		console.log(`  ${condition}: model IDs incomplete or invalid — no verdict`);
		continue;
	}
	const models = [...new Set(records.map((run) => run.model))].sort();
	const comparisons = models.map((model) => ({
		model,
		baseline: aggs.get(`${model} | A`),
		result: d20Gate(aggs.get(`${model} | A`), aggs.get(`${model} | ${condition}`)),
	}));
	const passing = comparisons.filter(({ result }) => result.verdict === "GO").length;
	const incomplete = comparisons.filter(({ result }) => result.verdict === null);
	const counts = `${passing}/${models.length} models meet both thresholds`;
	if (incomplete.length > 0) {
		console.log(`  ${condition}: ${counts}; ${incomplete.length} incomplete — no verdict`);
		for (const { model, result } of incomplete) console.log(`    ${model}: ${result.message}`);
	} else if (models.length < 2) {
		console.log(`  ${condition}: ${counts}; at least 2 models required — no verdict`);
	} else {
		const first = comparisons[0].baseline!;
		if (comparisons.some(({ baseline }) => !sameTaskCoverage(first, baseline!))) {
			console.log(`  ${condition}: ${counts}; task coverage differs across models — no verdict`);
		} else if (comparisons.some(({ baseline }) => !sameTaskVersions(first, baseline!))) {
			console.log(`  ${condition}: ${counts}; task versions differ across models — no verdict`);
		} else {
			console.log(`  ${condition}: ${counts} → ${passing >= 2 ? "GO" : "NO-GO"}`);
		}
	}
}
