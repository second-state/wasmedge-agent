/**
 * Offline metrics extraction (DESIGN.md §6.3): walks results/runs/<id>/meta.json
 * plus each run's session JSONL and emits a per-run CSV and per-condition
 * aggregates, checked against the D20 GO/NO-GO thresholds.
 *
 *   node poc/bench/analyze.ts [--csv results/bench.csv] [--d21 profile.json]
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launcherFields, launcherIdentity } from "./launchers.ts";
import { sameSourceInputs, sourceInputsHash, sourceInputsIdentity } from "./source-inputs.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "results", "runs");
const PLANS_DIR = join(HERE, "results", "plans");

interface D21Profile {
	version: 1;
	models: { sonnet: string; opus: string; openWeight: string };
	treatment: "F" | "B/example" | "B/noexample" | "B/split";
}

const d21Tasks = [
	"01-log-stats", "02-csv-normalize", "03-fix-bug", "04-multi-turn-state",
	"05-toolchain-loop", "06-build-cli", "07-todo-scan", "08-rust-rename",
	"09-helper-accumulation", "10-lint-fix", "11-join-report", "12-repair-config",
];

function readD21Profile(path: string): D21Profile {
	try {
		const profile: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(profile) || profile.version !== 1 ||
			Object.keys(profile).sort().join(",") !== "models,treatment,version" ||
			!isRecord(profile.models) || Object.keys(profile.models).sort().join(",") !== "openWeight,opus,sonnet" ||
			!Object.values(profile.models).every((model) =>
				typeof model === "string" && model.length > 0 && !/[\s|,]/.test(model)) ||
			new Set(Object.values(profile.models)).size !== 3 ||
			typeof profile.treatment !== "string" || !["F", "B/example", "B/noexample", "B/split"].includes(profile.treatment)) {
			throw new Error("expected version 1, three distinct model IDs in sonnet/opus/openWeight, and treatment F or B/example, B/noexample, B/split");
		}
		return profile as unknown as D21Profile;
	} catch (error) {
		throw new Error(`invalid D21 profile ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const options = new Map<string, string>();
let d21Profile: D21Profile | undefined;
try {
	for (let i = 2; i < process.argv.length; i += 2) {
		const flag = process.argv[i];
		const value = process.argv[i + 1];
		if (!["--csv", "--d21"].includes(flag) || options.has(flag) || !value || value.startsWith("--")) {
			throw new Error(`invalid argument ${flag}; usage: analyze.ts [--csv path] [--d21 profile.json]`);
		}
		options.set(flag, value);
	}
	const profilePath = options.get("--d21");
	if (profilePath) d21Profile = readD21Profile(profilePath);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}

type SessionStatus = "ok" | "missing" | "unreadable" | "invalid" | "empty";
type DriverStatus = "legacy" | "planned" | "running" | "completed" | "error" | "invalid";

interface CompileRecovery {
	recoveredErrors: number;
	unrecoveredErrors: number;
	distanceTotal: number;
}

interface RunMetrics {
	runId: string;
	planId: string | null;
	task: string;
	taskHash: string | null;
	providerConfigHash: string | null;
	sourceInputsHash: string | null;
	launcherHash: string | null;
	launcherIdentity: string | null;
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

const inventoryIssues: string[] = [];
const inventoryRecords: { path: string; meta: Record<string, unknown> }[] = [];
const runs: RunMetrics[] = [];
if (!existsSync(RUNS_DIR) && !existsSync(PLANS_DIR)) {
	console.error(`no runs at ${RUNS_DIR}`);
	process.exit(1);
}
for (const metaPath of existsSync(RUNS_DIR) ? findMetaFiles(RUNS_DIR) : []) {
	let meta;
	try {
		meta = JSON.parse(readFileSync(metaPath, "utf-8"));
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("invalid metadata");
	} catch {
		inventoryIssues.push(`unreadable or invalid run record: ${metaPath}`);
		continue;
	}
	inventoryRecords.push({ path: metaPath, meta });
	const launcher = launcherIdentity(meta);
	if (launcherFields.some((key) => meta[key] !== undefined) && !launcher) {
		inventoryIssues.push(`invalid agent launcher pin: ${metaPath}`);
	}
	if (meta.sourceInputs !== undefined && meta.sourceInputs !== null && !sourceInputsIdentity(meta.sourceInputs)) {
		inventoryIssues.push(`invalid source-input pin: ${metaPath}`);
	}
	const m: RunMetrics = {
		runId: meta.runId,
		planId: typeof meta.planId === "string" ? meta.planId : null,
		task: meta.task,
		taskHash: typeof meta.taskHash === "string" && /^sha256:[a-f0-9]{64}$/.test(meta.taskHash) ? meta.taskHash : null,
		providerConfigHash: typeof meta.providerConfigHash === "string" && /^sha256:[a-f0-9]{64}$/.test(meta.providerConfigHash) ? meta.providerConfigHash : null,
		sourceInputsHash: sourceInputsHash(meta.sourceInputs),
		launcherHash: launcher ? meta.launcherHash : null,
		launcherIdentity: launcher,
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

// Plans are locally recorded inventories, not tamper-proof attestations.
const slotFields = ["runId", "task", "taskHash", "providerConfigHash", "model", "group", "variant", "rep", ...launcherFields] as const;
const expectedRuns = new Map<string, { planId: string; slot: Record<string, unknown> }>();
const planIds = new Set<string>();
function validSlot(slot: unknown): slot is Record<string, unknown> {
	return isRecord(slot) &&
		["runId", "task", "model", "variant"].every((key) => typeof slot[key] === "string" && slot[key].trim().length > 0) &&
		["taskHash", "providerConfigHash"].every((key) => typeof slot[key] === "string" && /^sha256:[a-f0-9]{64}$/.test(slot[key])) &&
		typeof slot.group === "string" && ["A", "B", "F"].includes(slot.group) &&
		typeof slot.rep === "number" && Number.isSafeInteger(slot.rep) && slot.rep > 0;
}
for (const name of existsSync(PLANS_DIR) ? readdirSync(PLANS_DIR).sort() : []) {
	if (!name.endsWith(".json")) continue;
	let plan: unknown;
	try {
		plan = JSON.parse(readFileSync(join(PLANS_DIR, name), "utf-8"));
	} catch {
		inventoryIssues.push(`unreadable or invalid plan: ${name}`);
		continue;
	}
	if (!isRecord(plan) || plan.version !== 1 || typeof plan.planId !== "string" || !plan.planId ||
		name !== `${plan.planId}.json` || !Array.isArray(plan.runs) || !plan.runs.length || !plan.runs.every(validSlot)) {
		inventoryIssues.push(`invalid plan: ${name}`);
		continue;
	}
	if (plan.launcherPinVersion !== undefined && plan.launcherPinVersion !== 1 ||
		plan.runs.some((slot) => plan.launcherPinVersion === 1
			? !launcherIdentity(slot)
			: launcherFields.some((key) => slot[key] !== undefined))) {
		inventoryIssues.push(`invalid agent launcher pins in plan: ${name}`);
		continue;
	}
	if (plan.sourcePinVersion !== undefined && plan.sourcePinVersion !== 1 ||
		plan.runs.some((slot) => plan.sourcePinVersion === 1
			? slot.sourceInputs !== null && !sourceInputsIdentity(slot.sourceInputs)
			: slot.sourceInputs !== undefined)) {
		inventoryIssues.push(`invalid source-input pins in plan: ${name}`);
		continue;
	}
	planIds.add(plan.planId);
	const slots = new Set<string>();
	for (const slot of plan.runs) {
		const runId = String(slot.runId);
		const key = JSON.stringify([slot.task, slot.model, slot.group, slot.variant, slot.rep]);
		if (slots.has(key)) inventoryIssues.push(`duplicate planned slot: ${name} / ${runId}`);
		slots.add(key);
		if (expectedRuns.has(runId)) inventoryIssues.push(`duplicate planned run ID: ${runId}`);
		else expectedRuns.set(runId, { planId: plan.planId, slot });
	}
}
const recordsById = new Map<unknown, typeof inventoryRecords>();
for (const record of inventoryRecords) {
	const { runId, planId } = record.meta;
	recordsById.set(runId, [...(recordsById.get(runId) ?? []), record]);
	if (planId !== undefined && (typeof planId !== "string" || !planIds.has(planId))) {
		inventoryIssues.push(`missing or invalid plan for run: ${record.path}`);
	} else if (planId !== undefined && !expectedRuns.has(String(runId))) {
		inventoryIssues.push(`unplanned run record: ${record.path}`);
	}
}
for (const [runId, records] of recordsById) {
	if (records.length > 1) inventoryIssues.push(`duplicate run record: ${String(runId)}`);
}
let matchedRuns = 0;
for (const [runId, { planId, slot }] of expectedRuns) {
	const records = recordsById.get(runId) ?? [];
	if (!records.length) inventoryIssues.push(`missing run record: ${planId} / ${runId}`);
	else if (records.length === 1) {
		const meta = records[0].meta;
		if (meta.planId !== planId || slotFields.some((key) => meta[key] !== slot[key]) ||
			!sameSourceInputs(meta.sourceInputs, slot.sourceInputs)) {
			inventoryIssues.push(`run record differs from plan: ${planId} / ${runId}`);
		} else matchedRuns += 1;
	}
}
console.log(`Run inventory: ${matchedRuns}/${expectedRuns.size} planned records match; ${inventoryRecords.filter(({ meta }) => meta.planId === undefined).length} legacy records without a plan.`);
console.log(`Agent launcher pins: ${runs.filter((run) => run.launcherIdentity !== null).length}/${runs.length} records. Legacy-only comparisons do not verify launchers; entry-point fingerprints do not cover wrapper dependencies or toolchains.`);
console.log(`Declared source-input pins: ${runs.filter((run) => run.sourceInputsHash !== null).length}/${runs.length} records. Only operator-selected paths are verified; unpinned-only comparisons do not verify sources.`);
if (inventoryIssues.length) {
	console.log("Run inventory incomplete or inconsistent; aggregates describe discovered records only. All D20 verdicts are withheld.");
	for (const issue of inventoryIssues) console.log(`  ${issue}`);
}

function d21Coverage(profile: D21Profile): string[] {
	const issues: string[] = [];
	if (inventoryIssues.length) issues.push("D21 requires a consistent run inventory");
	const expected = new Map<string, number>();
	const treatmentGroup = profile.treatment === "F" ? "F" : "B";
	for (const task of d21Tasks) {
		for (const model of Object.values(profile.models)) {
			for (const group of ["A", treatmentGroup]) {
				for (const rep of [1, 2, 3]) {
					const variant = group === "A" ? "n/a" : group === "F" ? "builtin" :
						profile.treatment === "B/split" ? (rep % 2 ? "example" : "noexample") : profile.treatment.slice(2);
					expected.set(JSON.stringify([task, model, group, variant, rep]), 0);
				}
			}
		}
	}
	for (const run of runs) {
		const key = JSON.stringify([run.task, run.model, run.group, run.variant, run.rep]);
		const count = expected.get(key);
		if (count === undefined) issues.push(`unexpected D21 slot: ${key}`);
		else expected.set(key, count + 1);
		if (!run.planId || expectedRuns.get(run.runId)?.planId !== run.planId) {
			issues.push(`D21 run without a matching plan: ${run.runId}`);
		}
		if (run.driverStatus !== "completed") issues.push(`D21 run not completed: ${run.runId}`);
	}
	for (const [key, count] of expected) {
		if (count === 0) issues.push(`missing D21 slot: ${key}`);
		else if (count > 1) issues.push(`duplicate D21 slot: ${key}`);
	}
	return issues;
}

const d21Issues = d21Profile ? d21Coverage(d21Profile) : [];
if (d21Profile) {
	console.log("D21 model roles are operator declarations; provider aliases and routing are not verified.");
	for (const [role, model] of Object.entries(d21Profile.models)) console.log(`  ${role}: ${model}`);
	if (d21Issues.length) {
		console.log("D21 coverage: INCOMPLETE — all D20 verdicts are withheld.");
		for (const issue of d21Issues) console.log(`  ${issue}`);
	} else {
		console.log("D21 coverage: COMPLETE (216 slots). D20 evidence and thresholds are checked separately below.");
	}
} else {
	console.log("D21 coverage not checked; use --d21 profile.json to require the full matrix.");
}

// Per-run CSV
const csvPath = resolve(options.get("--csv") ?? join(HERE, "results", "bench.csv"));
const header =
	"runId,task,category,group,model,variant,rep,pass,timedOut,wallMs,tokensIn,tokensOut,assistantTurns,cellCount,compileErrorCells,cellP50Ms,cellP95Ms,errorToolResults,sessionStatus,recoveredCompileErrors,unrecoveredCompileErrors,compileRecoveryMeanCells,driverStatus,taskHash,providerConfigHash,planId,launcherHash,sourceInputsHash";
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
		m.providerConfigHash,
		m.planId,
		m.launcherHash,
		m.sourceInputsHash,
	].join(",");
});
writeFileSync(csvPath, [header, ...rows].join("\n"));
console.log(`wrote ${runs.length} run(s) → ${csvPath}\n`);

// Aggregates per (model, group)
interface Agg {
	runs: number;
	taskCounts: Map<string, number> | null;
	taskVersions: Map<string, string> | null;
	providerConfigHash: string | null;
	launcherStatus: "legacy" | "recorded" | "inconsistent";
	sourceStatus: "unpinned" | "recorded" | "inconsistent";
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
		providerConfigHash: new Set(ms.map((m) => m.providerConfigHash)).size === 1 ? ms[0].providerConfigHash : null,
		launcherStatus: new Set(ms.map((m) => m.launcherIdentity)).size !== 1
			? "inconsistent" : ms[0].launcherIdentity === null ? "legacy" : "recorded",
		sourceStatus: new Set(ms.map((m) => m.sourceInputsHash)).size !== 1
			? "inconsistent" : ms[0].sourceInputsHash === null ? "unpinned" : "recorded",
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
console.log("tasks = distinct task IDs; runs = discovered records, including planned runs that have not started; missing records appear under Run inventory.");
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
	if (inventoryIssues.length) return noVerdict("run inventory incomplete or inconsistent");
	if (d21Issues.length) return noVerdict("D21 matrix incomplete or inconsistent");
	if (!a) return noVerdict("baseline incomplete");
	if (!b) return noVerdict("treatment incomplete");
	if (a.driverIncompleteRuns || b.driverIncompleteRuns) return noVerdict("driver runs incomplete");
	if (!a.taskCounts || !b.taskCounts) return noVerdict("task IDs incomplete");
	if (!sameTaskCoverage(a, b)) return noVerdict("task coverage differs");
	if (!a.taskVersions || !b.taskVersions) return noVerdict("task versions incomplete or inconsistent");
	if (!sameTaskVersions(a, b)) return noVerdict("task versions differ");
	if (!a.providerConfigHash || !b.providerConfigHash) return noVerdict("provider config fingerprints incomplete or inconsistent");
	if (a.providerConfigHash !== b.providerConfigHash) return noVerdict("provider configs differ");
	if (a.launcherStatus === "inconsistent" || b.launcherStatus === "inconsistent" || a.launcherStatus !== b.launcherStatus) {
		return noVerdict("agent launcher fingerprints incomplete or inconsistent");
	}
	if (a.sourceStatus === "inconsistent" || b.sourceStatus === "inconsistent" || a.sourceStatus !== b.sourceStatus) {
		return noVerdict("source-input fingerprints incomplete or inconsistent");
	}
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
console.log("Each model needs matching models.json fingerprints across baseline and treatment; environment-resolved settings are not verified.");
const treatments = [...new Set(runs.map(conditionFor).filter(isTreatment))].sort();
const overallVerdicts = new Map<string, "GO" | "NO-GO">();
if (treatments.length === 0) console.log("  no treatment conditions — no verdict");
for (const condition of treatments) {
	if (inventoryIssues.length) {
		console.log(`  ${condition}: run inventory incomplete or inconsistent — no verdict`);
		continue;
	}
	if (d21Issues.length) {
		console.log(`  ${condition}: D21 matrix incomplete or inconsistent — no verdict`);
		continue;
	}
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
			const verdict = passing >= 2 ? "GO" : "NO-GO";
			overallVerdicts.set(condition, verdict);
			console.log(`  ${condition}: ${counts} → ${verdict}`);
		}
	}
}
if (d21Profile) {
	const required = d21Profile.treatment === "B/split" ? ["B/example", "B/noexample"] : [d21Profile.treatment];
	if (d21Issues.length || required.some((condition) => overallVerdicts.get(condition) !== "GO")) process.exitCode = 1;
}
