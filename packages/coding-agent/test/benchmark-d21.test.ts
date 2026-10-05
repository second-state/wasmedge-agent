import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const tasks = [
	"01-log-stats",
	"02-csv-normalize",
	"03-fix-bug",
	"04-multi-turn-state",
	"05-toolchain-loop",
	"06-build-cli",
	"07-todo-scan",
	"08-rust-rename",
	"09-helper-accumulation",
	"10-lint-fix",
	"11-join-report",
	"12-repair-config",
];
const models = { sonnet: "provider/sonnet", opus: "provider/opus", openWeight: "provider/open-weight" };
type Treatment = "F" | "B/example" | "B/noexample" | "B/split";

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(treatment: Treatment = "F") {
	const root = mkdtempSync(join(tmpdir(), "benchmark-d21-"));
	roots.push(root);
	const analyzer = join(root, "analyze.ts");
	copyFileSync(resolve(__dirname, "../../../poc/bench/analyze.ts"), analyzer);
	copyFileSync(resolve(__dirname, "../../../poc/bench/launchers.ts"), join(root, "launchers.ts"));
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	const runsDir = join(root, "results/runs");
	const plansDir = join(root, "results/plans");
	mkdirSync(runsDir, { recursive: true });
	mkdirSync(plansDir);
	const profile = { version: 1, models: { ...models }, treatment };
	const profilePath = join(root, "d21.json");
	const runs = Object.values(models).flatMap((model) =>
		tasks.flatMap((task) =>
			["A", treatment === "F" ? "F" : "B"].flatMap((group) =>
				[1, 2, 3].map((rep) => ({
					runId: `${model.slice(model.indexOf("/") + 1)}-${task}-${group}-${rep}`,
					planId: model.slice(model.indexOf("/") + 1),
					task,
					taskHash: `sha256:${"a".repeat(64)}`,
					providerConfigHash: `sha256:${"b".repeat(64)}`,
					model,
					group,
					variant:
						group === "A"
							? "n/a"
							: group === "F"
								? "builtin"
								: treatment === "B/split"
									? rep % 2
										? "example"
										: "noexample"
									: treatment.slice(2),
					rep,
					driverStatus: "completed" as string | undefined,
					checkPass: true as boolean | undefined,
					timedOut: false,
					wallMs: 1,
					category: "fixture",
				})),
			),
		),
	);
	const missingUsage = new Set<string>();
	const tokenMisses = new Set<string>();
	return {
		profile,
		runs,
		missingUsage,
		tokenMisses,
		run({
			legacy = false,
			args = ["--d21", profilePath],
			rawProfile,
		}: {
			legacy?: boolean;
			args?: string[];
			rawProfile?: string;
		} = {}) {
			writeFileSync(profilePath, rawProfile ?? JSON.stringify(profile));
			const plans = new Map<string, Record<string, unknown>[]>();
			for (const run of runs) {
				const runDir = join(runsDir, run.runId);
				mkdirSync(runDir);
				const sessionFile = join(runDir, "session.jsonl");
				writeFileSync(
					sessionFile,
					JSON.stringify({
						type: "message",
						message: {
							role: "assistant",
							usage: missingUsage.has(run.runId)
								? undefined
								: {
										input: 10,
										output: run.group !== "A" && tokenMisses.has(run.model) ? 201 : 100,
									},
						},
					}),
				);
				writeFileSync(
					join(runDir, "meta.json"),
					JSON.stringify({ ...run, planId: legacy ? undefined : run.planId, sessionFile }),
				);
				plans.set(run.planId, [
					...(plans.get(run.planId) ?? []),
					Object.fromEntries(
						["runId", "task", "taskHash", "providerConfigHash", "model", "group", "variant", "rep"].map((key) => [
							key,
							run[key as keyof typeof run],
						]),
					),
				]);
			}
			if (!legacy)
				for (const [planId, slots] of plans) {
					writeFileSync(join(plansDir, `${planId}.json`), JSON.stringify({ version: 1, planId, runs: slots }));
				}
			const csvPath = join(root, "metrics.csv");
			const result = spawnSync(
				process.execPath,
				["--experimental-strip-types", analyzer, "--csv", csvPath, ...args],
				{
					encoding: "utf-8",
					timeout: 10_000,
				},
			);
			expect(result.error).toBeUndefined();
			return { ...result, csvPath };
		},
	};
}

describe("D21 benchmark matrix", () => {
	it.each<Treatment>(["F", "B/example", "B/noexample", "B/split"])("accepts a complete %s matrix", (treatment) => {
		const f = fixture(treatment);
		const { status, stdout, csvPath } = f.run();
		expect(status).toBe(0);
		expect(stdout).toContain("D21 coverage: COMPLETE (216 slots)");
		expect(stdout).toContain("3/3 models meet both thresholds → GO");
		if (treatment === "B/split") {
			for (const variant of ["example", "noexample"])
				expect(stdout).toContain(`B/${variant}: 3/3 models meet both thresholds → GO`);
		}
		expect(readFileSync(csvPath, "utf-8").split("\n")).toHaveLength(217);
	});

	it.each(["model", "task", "repetition", "all"])(
		"detects an entirely absent %s even without a saved plan",
		(missing) => {
			const f = fixture();
			const retained = f.runs.filter((run) =>
				missing === "model"
					? run.model !== models.openWeight
					: missing === "task"
						? run.task !== tasks[11]
						: missing === "repetition"
							? run.rep !== 3
							: false,
			);
			f.runs.splice(0, f.runs.length, ...retained);
			const { status, stdout, csvPath } = f.run();
			expect(status).toBe(1);
			expect(stdout).toContain("D21 coverage: INCOMPLETE");
			expect(stdout).toContain("missing D21 slot");
			expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
			expect(readFileSync(csvPath, "utf-8").split("\n")).toHaveLength(retained.length + 1);
		},
	);

	it("rejects the same matrix slot repeated in independent plans", () => {
		const f = fixture();
		f.runs.push({ ...f.runs[0], runId: "extra-run", planId: "extra-plan" });
		const { status, stdout } = f.run();
		expect(status).toBe(1);
		expect(stdout).toContain("duplicate D21 slot");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
	});

	it.each(["model", "task", "group", "variant", "rep"])(
		"rejects an unexpected %s instead of selecting matching runs",
		(field) => {
			const f = fixture();
			Object.assign(f.runs[0], { [field]: field === "rep" ? 4 : "unexpected" });
			const { status, stdout } = f.run();
			expect(status).toBe(1);
			expect(stdout).toContain("unexpected D21 slot");
			expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
		},
	);

	it("requires the preregistered D17 split for each repetition", () => {
		const f = fixture("B/split");
		for (const run of f.runs) if (run.group === "B") run.variant = run.rep === 1 ? "noexample" : "example";
		const { status, stdout } = f.run();
		expect(status).toBe(1);
		expect(stdout).toContain("unexpected D21 slot");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
	});

	it.each([undefined, "planned", "running", "error"])("requires completed driver records, not %s", (driverStatus) => {
		const f = fixture();
		f.runs[0].driverStatus = driverStatus;
		const { status, stdout } = f.run();
		expect(status).toBe(1);
		expect(stdout).toContain("D21 run not completed");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
	});

	it("requires inventory-backed runs even when legacy measurements match the matrix", () => {
		const { status, stdout } = fixture().run({ legacy: true });
		expect(status).toBe(1);
		expect(stdout).toContain("D21 run without a matching plan");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
	});

	it.each(["usage", "check", "task version", "provider config"])(
		"keeps the D20 evidence gate after coverage passes: %s",
		(missing) => {
			const f = fixture();
			if (missing === "usage") f.missingUsage.add(f.runs[0].runId);
			if (missing === "check") f.runs[0].checkPass = undefined;
			if (missing === "task version") f.runs[0].taskHash = `sha256:${"c".repeat(64)}`;
			if (missing === "provider config") f.runs[0].providerConfigHash = `sha256:${"c".repeat(64)}`;
			const { status, stdout } = f.run();
			expect(status).toBe(1);
			expect(stdout).toContain("D21 coverage: COMPLETE (216 slots)");
			expect(stdout).toContain("1 incomplete — no verdict");
		},
	);

	it.each([1, 2])("uses D20's two-model threshold after full coverage: %s models fail", (failing) => {
		const f = fixture();
		for (const model of Object.values(models).slice(0, failing)) f.tokenMisses.add(model);
		const { status, stdout } = f.run();
		expect(status).toBe(failing === 1 ? 0 : 1);
		expect(stdout).toContain(`F: ${3 - failing}/3 models meet both thresholds → ${failing === 1 ? "GO" : "NO-GO"}`);
	});

	it.each([
		"{",
		"null",
		"[]",
		JSON.stringify({ version: 2, models, treatment: "F" }),
		JSON.stringify({ version: 1, models: { sonnet: models.sonnet, opus: models.opus }, treatment: "F" }),
		JSON.stringify({ version: 1, models: { ...models, openWeight: models.opus }, treatment: "F" }),
		JSON.stringify({ version: 1, models: { ...models, openWeight: " " }, treatment: "F" }),
		JSON.stringify({ version: 1, models: { ...models, openWeight: 42 }, treatment: "F" }),
		JSON.stringify({ version: 1, models, treatment: "B" }),
		JSON.stringify({ version: 1, models, treatment: "F", reps: 1 }),
	])("rejects invalid D21 profiles: %s", (rawProfile) => {
		const { status, stderr } = fixture().run({ rawProfile });
		expect(status).toBe(2);
		expect(stderr).toContain("invalid D21 profile");
	});

	it.each([["--d21"], ["--d21", "--csv"], ["--d21", "missing.json"], ["--d12", "wrong.json"]])(
		"fails closed on CLI mistakes: %s",
		(...args) => {
			const { status, stdout } = fixture().run({ args });
			expect(status).toBe(2);
			expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
		},
	);

	it("retains selected-sample analysis unless D21 is requested", () => {
		const f = fixture();
		f.runs.splice(
			0,
			f.runs.length,
			...f.runs.filter((run) => run.task === tasks[0] && run.rep === 1 && run.model !== models.openWeight),
		);
		const { status, stdout } = f.run({ args: [] });
		expect(status).toBe(0);
		expect(stdout).toContain("2/2 models meet both thresholds → GO");
		expect(stdout).not.toContain("D21 coverage: COMPLETE");
	});
});
