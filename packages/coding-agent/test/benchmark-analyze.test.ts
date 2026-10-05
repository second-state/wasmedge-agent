import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	copyFileSync(join(repo, "poc/bench/launchers.ts"), join(root, "launchers.ts"));
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	mkdirSync(join(root, "results/runs"), { recursive: true });
	let nextId = 0;
	return {
		runsDir: join(root, "results/runs"),
		registerPlan(planId = "fixture-plan") {
			const runs = readdirSync(join(root, "results/runs")).map((id) => {
				const path = join(root, "results/runs", id, "meta.json");
				const meta = JSON.parse(readFileSync(path, "utf-8"));
				writeFileSync(path, JSON.stringify({ ...meta, planId }));
				return Object.fromEntries(
					[
						"runId",
						"task",
						"taskHash",
						"providerConfigHash",
						"model",
						"group",
						"variant",
						"rep",
						"launcherPath",
						"launcherRealPath",
						"launcherHash",
					].map((key) => [key, meta[key]]),
				);
			});
			const dir = join(root, "results/plans");
			mkdirSync(dir, { recursive: true });
			const path = join(dir, `${planId}.json`);
			writeFileSync(
				path,
				JSON.stringify({
					version: 1,
					planId,
					runs,
					launcherPinVersion: runs.some((run) => run.launcherHash !== undefined) ? 1 : undefined,
				}),
			);
			return path;
		},
		add({
			task = "fixture",
			taskHash = `sha256:${"a".repeat(64)}`,
			providerConfigHash = `sha256:${"c".repeat(64)}`,
			model = "fixture-model",
			group = "A",
			variant = "example",
			tokensOut,
			tokensIn = 0,
			durations = [],
			pass = true,
		}: {
			task?: string;
			taskHash?: string | null;
			providerConfigHash?: string | null;
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
					taskHash: taskHash ?? undefined,
					providerConfigHash: providerConfigHash ?? undefined,
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

function overall(stdout: string) {
	const section = stdout.split("\nD20 overall (per treatment):")[1];
	expect(section, "missing overall D20 summary").toBeDefined();
	return section!;
}

describe("benchmark launcher evidence", () => {
	function addPinned(f: ReturnType<typeof fixture>, group: string, override: Record<string, unknown> = {}) {
		const run = f.add({ group, tokensOut: 100 });
		const meta = JSON.parse(readFileSync(run.metaPath, "utf-8"));
		writeFileSync(
			run.metaPath,
			JSON.stringify({
				...meta,
				launcherPath: `/bench/${group}`,
				launcherRealPath: `/bench/installed/${group}`,
				launcherHash: `sha256:${(group === "A" ? "a" : "f").repeat(64)}`,
				...override,
			}),
		);
		return run;
	}

	it("compares distinct baseline/treatment launchers without accessing current executable files", () => {
		const f = fixture();
		addPinned(f, "A");
		addPinned(f, "F");
		f.registerPlan();
		const { stdout, csv } = f.run();
		expect(stdout).toContain("Agent launcher pins: 2/2 records");
		expect(stdout).toContain("F: pass 100% vs A 100% OK; tokensOut 100 vs A 100 OK → GO");
		expect(csvRows(csv).map((row) => row.launcherHash)).toEqual([
			`sha256:${"a".repeat(64)}`,
			`sha256:${"f".repeat(64)}`,
		]);
	});

	it.each([
		{ launcherPath: "/another/entry" },
		{ launcherRealPath: "/another/target" },
		{ launcherHash: `sha256:${"e".repeat(64)}` },
	])("withholds verdicts for mixed identities within a condition: %j", (override) => {
		const f = fixture();
		addPinned(f, "A");
		addPinned(f, "F");
		addPinned(f, "F", override);
		f.registerPlan();
		const { stdout } = f.run();
		expect(stdout).toContain("Run inventory: 3/3 planned records match");
		expect(stdout).toContain("agent launcher fingerprints incomplete or inconsistent — no verdict");
		expect(stdout).not.toContain("→ GO");
	});

	it.each([false, true])(
		"withholds comparisons mixing pinned and legacy evidence (same condition: %s)",
		(sameCondition) => {
			const f = fixture();
			f.add({ group: "A", tokensOut: 100 });
			addPinned(f, "F");
			if (sameCondition) f.add({ group: "F", tokensOut: 100 });
			const { stdout } = f.run();
			expect(stdout).toContain("agent launcher fingerprints incomplete or inconsistent — no verdict");
			expect(stdout).not.toContain("→ GO");
		},
	);

	it.each([{ launcherPath: "relative/path" }, { launcherRealPath: null }, { launcherHash: "unknown" }])(
		"rejects malformed recorded launcher evidence: %j",
		(override) => {
			const f = fixture();
			addPinned(f, "A");
			addPinned(f, "F", override);
			f.registerPlan();
			const { stdout } = f.run();
			expect(stdout).toContain("invalid agent launcher pin");
			expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
		},
	);

	it.each(["launcherPath", "launcherRealPath", "launcherHash"])("checks %s against the saved inventory", (key) => {
		const f = fixture();
		addPinned(f, "A");
		const run = addPinned(f, "F");
		f.registerPlan();
		const meta = JSON.parse(readFileSync(run.metaPath, "utf-8"));
		delete meta[key];
		writeFileSync(run.metaPath, JSON.stringify(meta));
		const { stdout } = f.run();
		expect(stdout).toContain("run record differs from plan");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
	});

	it.each([undefined, 99])("rejects pinned plans without a supported pin version: %s", (launcherPinVersion) => {
		const f = fixture();
		addPinned(f, "A");
		addPinned(f, "F");
		const path = f.registerPlan();
		const plan = JSON.parse(readFileSync(path, "utf-8"));
		writeFileSync(path, JSON.stringify({ ...plan, launcherPinVersion }));
		const { stdout } = f.run();
		expect(stdout).toContain("invalid agent launcher pins in plan");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
	});
});

describe("benchmark run inventory", () => {
	it("retains D20 verdicts for complete plans and identifies their CSV records", () => {
		const f = fixture();
		for (const model of ["model-a", "model-b"]) {
			for (const group of ["A", "B", "F"]) f.add({ model, group, tokensOut: 100 });
		}
		f.registerPlan();
		const { stdout, csv } = f.run();
		expect(stdout).toContain("Run inventory: 6/6 planned records match; 0 legacy records");
		for (const condition of ["F", "B/example"]) {
			expect(overall(stdout)).toContain(`${condition}: 2/2 models meet both thresholds → GO`);
		}
		expect(csvRows(csv).every((row) => row.planId === "fixture-plan")).toBe(true);
	});

	it("withholds verdicts when every record for a planned third model disappears", () => {
		const f = fixture();
		const removed: string[] = [];
		for (const model of ["model-a", "model-b", "model-c"]) {
			for (const group of ["A", "F"]) {
				const { metaPath } = f.add({ model, group, tokensOut: 100 });
				if (model === "model-c") removed.push(metaPath);
			}
		}
		f.registerPlan();
		for (const path of removed) rmSync(path);
		const { stdout, csv } = f.run();
		expect(stdout).toContain("run inventory incomplete or inconsistent — no verdict");
		expect(stdout).toContain("missing run record");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
		expect(csvRows(csv)).toHaveLength(4);
	});

	it.each(["A", "B", "F"])("detects a missing %s repetition even if task weights still match", (group) => {
		const f = fixture();
		const paths: string[] = [];
		for (const condition of ["A", "B", "F"]) {
			for (let rep = 0; rep < 2; rep++) {
				const { metaPath } = f.add({ group: condition, tokensOut: 100 });
				if (condition === group) paths.push(metaPath);
			}
		}
		f.registerPlan();
		rmSync(paths[0]);
		const { stdout } = f.run();
		expect(stdout).toContain("Run inventory: 5/6 planned records match");
		expect(stdout).toContain("missing run record");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
	});

	it("reports absent planned runs even when the entire runs directory is removed", () => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		f.add({ group: "F", tokensOut: 100 });
		f.registerPlan();
		rmSync(f.runsDir, { recursive: true });
		const { stdout, csv } = f.run();
		expect(stdout).toContain("Run inventory: 0/2 planned records match");
		expect(stdout.match(/missing run record/g)).toHaveLength(2);
		expect(csvRows(csv)).toEqual([]);
	});

	it.each(["runId", "task", "taskHash", "providerConfigHash", "model", "group", "variant", "rep", "planId"])(
		"withholds verdicts when a run's %s no longer matches its plan",
		(field) => {
			const f = fixture();
			f.add({ tokensOut: 100 });
			const { metaPath } = f.add({ group: "F", tokensOut: 100 });
			f.registerPlan();
			const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
			meta[field] = field === "rep" ? 99 : field.endsWith("Hash") ? `sha256:${"f".repeat(64)}` : "changed";
			writeFileSync(metaPath, JSON.stringify(meta));
			const { stdout, csv } = f.run();
			expect(stdout).toContain("Run inventory incomplete or inconsistent");
			expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
			expect(csvRows(csv)).toHaveLength(2);
		},
	);

	it.each([undefined, null, 42, ""])("rejects a lost or invalid plan link: %s", (planId) => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		const { metaPath } = f.add({ group: "F", tokensOut: 100 });
		f.registerPlan();
		const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
		writeFileSync(metaPath, JSON.stringify({ ...meta, planId }));
		expect(f.run().stdout).toContain("run inventory incomplete or inconsistent — no verdict");
	});

	it("rejects extra and duplicate records while retaining their observed metrics", () => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		const { metaPath } = f.add({ group: "F", tokensOut: 100 });
		f.registerPlan();
		const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
		for (const id of ["duplicate", "extra"]) {
			mkdirSync(join(f.runsDir, id));
			writeFileSync(
				join(f.runsDir, id, "meta.json"),
				JSON.stringify({ ...meta, runId: id === "extra" ? id : meta.runId }),
			);
		}
		const { stdout, csv } = f.run();
		expect(stdout).toContain("duplicate run record");
		expect(stdout).toContain("unplanned run record");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
		expect(csvRows(csv)).toHaveLength(4);
	});

	it.each(["missing", "json", "version", "id", "empty", "invalid slot", "duplicate ID", "duplicate slot"])(
		"withholds verdicts for a %s plan",
		(problem) => {
			const f = fixture();
			f.add({ tokensOut: 100 });
			f.add({ group: "F", tokensOut: 100 });
			const path = f.registerPlan();
			const plan = JSON.parse(readFileSync(path, "utf-8"));
			if (problem === "version") plan.version = 2;
			if (problem === "id") plan.planId = "different";
			if (problem === "empty") plan.runs = [];
			if (problem === "invalid slot") plan.runs[0].rep = 0;
			if (problem === "duplicate ID") plan.runs.push(plan.runs[0]);
			if (problem === "duplicate slot") plan.runs.push({ ...plan.runs[0], runId: "different" });
			writeFileSync(path, problem === "json" ? "{" : JSON.stringify(plan));
			if (problem === "missing") rmSync(path);
			const { stdout, csv } = f.run();
			expect(stdout).toContain("run inventory incomplete or inconsistent — no verdict");
			expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
			expect(csvRows(csv)).toHaveLength(2);
		},
	);

	it.each(["{", "null", "[]"])("retains other observations when run metadata is invalid: %s", (source) => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		const { metaPath } = f.add({ group: "F", tokensOut: 100 });
		f.registerPlan();
		writeFileSync(metaPath, source);
		const { stdout, csv } = f.run();
		expect(stdout).toContain("unreadable or invalid run record");
		expect(stdout).toContain("missing run record");
		expect(csvRows(csv)).toHaveLength(1);
	});
});

describe("overall D20 gate", () => {
	it.each(["B", "F"])("requires two distinct models, not repeated runs of %s", (group) => {
		const f = fixture();
		for (let rep = 0; rep < 3; rep++) {
			f.add({ tokensOut: 100 });
			f.add({ group, tokensOut: 100 });
		}
		expect(overall(f.run().stdout)).toContain(
			"1/1 models meet both thresholds; at least 2 models required — no verdict",
		);
	});

	it.each(["B", "F"])("reports GO for two complete passing models in %s", (group) => {
		const f = fixture();
		for (const model of ["model-a", "model-b"]) {
			f.add({ model, tokensOut: 100 });
			f.add({ model, group, tokensOut: 200 });
		}
		expect(overall(f.run().stdout)).toContain(
			`${group}${group === "B" ? "/example" : ""}: 2/2 models meet both thresholds → GO`,
		);
	});

	it.each([0, 1, 2, 3])("counts models meeting both thresholds together: %s of 3", (passing) => {
		const f = fixture();
		for (let index = 0; index < 3; index++) {
			const model = `model-${index}`;
			f.add({ model, tokensOut: 100 });
			f.add({ model, group: "F", tokensOut: index < passing ? 100 : 201 });
		}
		expect(overall(f.run().stdout)).toContain(
			`F: ${passing}/3 models meet both thresholds → ${passing >= 2 ? "GO" : "NO-GO"}`,
		);
	});

	it("does not combine a pass-rate-only model with a token-only model", () => {
		const f = fixture();
		for (const model of ["model-a", "model-b"]) {
			f.add({ model, tokensOut: 100 });
			f.add({ model, group: "F", tokensOut: model === "model-a" ? 201 : 100, pass: model === "model-a" });
		}
		expect(overall(f.run().stdout)).toContain("F: 0/2 models meet both thresholds → NO-GO");
	});

	it("keeps F and both B variants separate even when each has a different passing model", () => {
		const f = fixture();
		for (const [index, model] of ["model-a", "model-b", "model-c"].entries()) {
			f.add({ model, tokensOut: 100 });
			for (const [condition, [group, variant]] of [
				["F", ""],
				["B", "example"],
				["B", "noexample"],
			].entries()) {
				f.add({ model, group, variant, tokensOut: index === condition ? 100 : 201 });
			}
		}
		const output = overall(f.run().stdout);
		for (const condition of ["F", "B/example", "B/noexample"]) {
			expect(output).toContain(`${condition}: 1/3 models meet both thresholds → NO-GO`);
		}
		expect(output).not.toContain("→ GO");
	});

	it.each(["baseline", "treatment", "planned", "session", "usage", "check", "version", "provider config"])(
		"withholds the overall verdict when a third model has incomplete %s evidence",
		(problem) => {
			const f = fixture();
			for (const model of ["model-a", "model-b"]) {
				f.add({ model, tokensOut: 100 });
				f.add({ model, group: "F", tokensOut: 100 });
			}
			if (problem !== "baseline") f.add({ model: "model-c", tokensOut: 100 });
			if (problem !== "treatment") {
				const { sessionFile, metaPath } = f.add({ model: "model-c", group: "F", tokensOut: 100 });
				const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
				if (problem === "planned") meta.driverStatus = "planned";
				if (problem === "check") delete meta.checkPass;
				if (problem === "version") delete meta.taskHash;
				if (problem === "provider config") delete meta.providerConfigHash;
				writeFileSync(metaPath, JSON.stringify(meta));
				if (problem === "session") rmSync(sessionFile);
				if (problem === "usage") writeMessages(sessionFile, [{ role: "assistant" }]);
			}
			const output = overall(f.run().stdout);
			expect(output).toContain("F: 2/3 models meet both thresholds; 1 incomplete — no verdict");
			expect(output).toContain("model-c:");
			expect(output).not.toMatch(/→ (GO|NO-GO)/);
		},
	);

	it.each(["coverage", "weight", "version"])("requires matching task %s across models", (difference) => {
		const f = fixture();
		for (const model of ["model-a", "model-b"]) {
			for (const group of ["A", "F"]) {
				f.add({ model, group, task: "logs", tokensOut: 100 });
				f.add({
					model,
					group,
					task: difference === "coverage" && model === "model-b" ? "other" : "rename",
					taskHash: `sha256:${(difference === "version" && model === "model-b" ? "b" : "a").repeat(64)}`,
					tokensOut: 100,
				});
				if (difference === "weight" && model === "model-b") f.add({ model, group, task: "logs", tokensOut: 100 });
			}
		}
		expect(overall(f.run().stdout)).toContain(
			`F: 2/2 models meet both thresholds; task ${difference === "version" ? "versions differ" : "coverage differs"} across models — no verdict`,
		);
	});

	it("allows proportional repetition counts across models and conditions", () => {
		const f = fixture();
		for (const model of ["model-a", "model-b"]) {
			for (const group of ["A", "F"]) {
				const reps = (model === "model-a" ? 2 : 1) * (group === "A" ? 3 : 1);
				for (let rep = 0; rep < reps; rep++) {
					for (const task of ["logs", "rename"]) f.add({ model, group, task, tokensOut: 100 });
				}
			}
		}
		expect(overall(f.run().stdout)).toContain("F: 2/2 models meet both thresholds → GO");
	});

	it.each([undefined, null, 42, "", " ", " model-a", "model | alias"])(
		"rejects invalid model identity %s",
		(model) => {
			const f = fixture();
			for (const group of ["A", "F"]) {
				f.add({ model: "model-a", group, tokensOut: 100 });
				const { metaPath } = f.add({ group, tokensOut: 100 });
				const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
				writeFileSync(metaPath, JSON.stringify({ ...meta, model }));
			}
			expect(overall(f.run().stdout)).toContain("F: model IDs incomplete or invalid — no verdict");
		},
	);

	it.each([false, true])("reports no verdict without treatments (baseline present: %s)", (baseline) => {
		const f = fixture();
		if (baseline) f.add({ tokensOut: 100 });
		expect(overall(f.run().stdout)).toContain("no treatment conditions — no verdict");
	});

	it.each([undefined, null, "", "unknown"])("withholds an overall B verdict for variant %s", (variant) => {
		const f = fixture();
		for (const model of ["model-a", "model-b"]) {
			f.add({ model, tokensOut: 100 });
			const { metaPath } = f.add({ model, group: "B", tokensOut: 100 });
			const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
			writeFileSync(metaPath, JSON.stringify({ ...meta, variant }));
		}
		expect(overall(f.run().stdout)).toContain("treatment variant incomplete or invalid — no verdict");
	});
});

describe("offline benchmark analyzer", () => {
	it.each(["B", "F"])("withholds the %s verdict for different provider configs", (group) => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		const providerConfigHash = `sha256:${"d".repeat(64)}`;
		f.add({ group, tokensOut: 100, providerConfigHash });
		const { stdout, csv } = f.run();
		expect(stdout).toContain("provider configs differ — no verdict");
		expect(stdout).not.toContain("→ GO");
		expect(csvRows(csv).at(-1)).toMatchObject({ providerConfigHash, tokensOut: "100", pass: "true" });
	});
	it.each(
		["A", "F"].flatMap((group) =>
			[undefined, null, 42, "", "sha256:abcd", "c".repeat(64)].map((providerConfigHash) => ({
				group,
				providerConfigHash,
			})),
		),
	)("withholds the verdict for $group provider config hash $providerConfigHash", ({ group, providerConfigHash }) => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		f.add({ group: "F", tokensOut: 100 });
		const { metaPath } = f.add({ group, tokensOut: 100 });
		const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
		writeFileSync(metaPath, JSON.stringify({ ...meta, providerConfigHash }));
		const { stdout, csv } = f.run();
		expect(csvRows(csv).at(-1)).toMatchObject({ providerConfigHash: "", tokensOut: "100", pass: "true" });
		expect(summary(stdout, `fixture-model | ${group}`)).toMatchObject({ pass: "100%", tokensOut: 100 });
		expect(stdout).toContain("provider config fingerprints incomplete or inconsistent — no verdict");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
	});
	it.each(["A", "F"])("rejects mixed provider configs across %s tasks", (group) => {
		const f = fixture();
		for (const condition of ["A", "F"]) {
			f.add({ group: condition, task: "logs", tokensOut: 100 });
			f.add({
				group: condition,
				task: "rename",
				providerConfigHash: condition === group ? `sha256:${"d".repeat(64)}` : undefined,
				tokensOut: 100,
			});
		}
		expect(f.run().stdout).toContain("provider config fingerprints incomplete or inconsistent — no verdict");
	});
	it("compares config fingerprints within each model and keeps B variants separate", () => {
		const f = fixture();
		for (const [index, model] of ["model-a", "model-b"].entries()) {
			const providerConfigHash = `sha256:${String(index).repeat(64)}`;
			for (const group of ["A", "F", "B"]) f.add({ model, group, providerConfigHash, tokensOut: 100 });
			f.add({ model, group: "B", variant: "noexample", tokensOut: 100 });
		}
		const { stdout } = f.run();
		for (const condition of ["F", "B/example"]) {
			expect(overall(stdout)).toContain(`${condition}: 2/2 models meet both thresholds → GO`);
		}
		expect(overall(stdout)).toContain("B/noexample: 0/2 models meet both thresholds; 2 incomplete — no verdict");
		expect(stdout).toContain("provider configs differ — no verdict");
	});
	it.each(["B", "F"])("withholds the %s verdict for different task versions", (group) => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		f.add({ group, tokensOut: 100, taskHash: `sha256:${"b".repeat(64)}` });
		const { stdout, csv } = f.run();
		const condition = `fixture-model | ${group}${group === "B" ? "/example" : ""}`;
		expect(stdout).toContain(`${condition}: task versions differ — no verdict`);
		expect(stdout).not.toContain("→ GO");
		expect(csvRows(csv).at(-1)?.taskHash).toBe(`sha256:${"b".repeat(64)}`);
	});
	it.each(
		["A", "F"].flatMap((group) =>
			[undefined, null, 42, "", "sha256:abcd", "a".repeat(64)].map((taskHash) => ({ group, taskHash })),
		),
	)("withholds verdicts for $group task hash $taskHash while retaining metrics", ({ group, taskHash }) => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		f.add({ group: "F", tokensOut: 100 });
		const { metaPath } = f.add({ group, tokensOut: 100 });
		const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
		writeFileSync(metaPath, JSON.stringify({ ...meta, taskHash }));
		const { stdout, csv } = f.run();
		expect(csvRows(csv).at(-1)).toMatchObject({ taskHash: "", tokensOut: "100", pass: "true" });
		expect(summary(stdout, `fixture-model | ${group}`)).toMatchObject({ pass: "100%", tokensOut: 100 });
		expect(stdout).toContain("fixture-model | F: task versions incomplete or inconsistent — no verdict");
	});
	it.each(["A", "F"])("rejects mixed task versions within %s even when another run matches", (group) => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		f.add({ group: "F", tokensOut: 100 });
		f.add({ group, tokensOut: 100, taskHash: `sha256:${"b".repeat(64)}` });
		expect(f.run().stdout).toContain("fixture-model | F: task versions incomplete or inconsistent — no verdict");
	});
	it("matches versions by task and keeps prompt variants separate", () => {
		const f = fixture();
		const hashes = ["a", "b"].map((letter) => `sha256:${letter.repeat(64)}`);
		for (const [index, task] of ["logs", "rename"].entries()) {
			for (let rep = 0; rep < 3; rep++) f.add({ task, taskHash: hashes[index], tokensOut: 100 });
			f.add({ task, group: "B", taskHash: hashes[index], tokensOut: 100 });
			f.add({ task, group: "B", variant: "noexample", taskHash: hashes[1 - index], tokensOut: 100 });
		}
		const { stdout } = f.run();
		expect(stdout).toContain("fixture-model | B/example: pass 100% vs A 100% OK; tokensOut 100 vs A 100 OK → GO");
		expect(stdout).toContain("fixture-model | B/noexample: task versions differ — no verdict");
	});
	it.each(
		["A", "F"].flatMap((group) =>
			["planned", "running", "error", "unknown", null, 0].map((driverStatus) => ({ group, driverStatus })),
		),
	)(
		"withholds aggregate metrics and verdicts for $group with driver status $driverStatus",
		({ group, driverStatus }) => {
			const f = fixture();
			f.add({ tokensOut: 100 });
			f.add({ group: "F", tokensOut: 100 });
			const { metaPath } = f.add({ group, tokensOut: 100, durations: [10] });
			const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
			writeFileSync(metaPath, JSON.stringify({ ...meta, driverStatus }));
			const { stdout, csv } = f.run();
			// Recorded observations stay visible, but may be only part of the run.
			expect(csvRows(csv).at(-1)).toMatchObject({
				driverStatus: ["planned", "running", "error"].includes(String(driverStatus)) ? driverStatus : "invalid",
				tokensOut: "100",
			});
			expect(summary(stdout, `fixture-model | ${group}`)).toMatchObject({
				runs: 2,
				tasks: 1,
				pass: "n/a",
				tokensOut: Number.NaN,
				tokensIn: Number.NaN,
				cells: Number.NaN,
				compileErrors: "n/a",
				cellP50: "n/a",
			});
			expect(recoverySummary(stdout, `fixture-model | ${group}`).recoveredErrors).toBeNaN();
			expect(stdout).toContain("fixture-model | F: driver runs incomplete — no verdict");
			expect(stdout).not.toContain("→ GO");
		},
	);
	it.each([undefined, "completed"])("accepts complete evidence with driver status %s", (driverStatus) => {
		const f = fixture();
		f.add({ tokensOut: 100 });
		const { metaPath } = f.add({ group: "F", tokensOut: 100 });
		const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
		writeFileSync(metaPath, JSON.stringify({ ...meta, driverStatus }));
		const { stdout, csv } = f.run();
		expect(csvRows(csv).at(-1)?.driverStatus).toBe(driverStatus ?? "legacy");
		expect(stdout).toContain("fixture-model | F: pass 100% vs A 100% OK; tokensOut 100 vs A 100 OK → GO");
	});
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
			["", ""],
		]);
	});
	it.each(
		["A", "F"].flatMap((group) =>
			[
				"null",
				"[]",
				"{}",
				'{"durationMs":null}',
				'{"durationMs":"10"}',
				'{"durationMs":true}',
				'{"durationMs":-1}',
				'{"durationMs":1e400}',
				'{"durationMs":-1e400}',
			].map((details) => ({ group, details })),
		),
	)("withholds incomplete cell timings for $group with details $details", ({ group, details }) => {
		const f = fixture();
		f.add({ tokensOut: 100, durations: [10] });
		f.add({ group: "F", tokensOut: 100, durations: [20] });
		const { sessionFile } = f.add({ group, tokensOut: 100, durations: [30] });
		const toolName = group === "A" ? "ipython" : "rust";
		const source = readFileSync(sessionFile, "utf-8");
		// Raw JSON preserves overflowing numbers, which JSON.stringify replaces with null.
		writeFileSync(
			sessionFile,
			`${source}\n{"type":"message","message":{"role":"toolResult","toolName":"${toolName}","details":${details}}}\n${JSON.stringify(
				{
					type: "message",
					message: { role: "toolResult", toolName, details: { durationMs: 50, status: "ok" } },
				},
			)}`,
		);
		const { stdout, csv } = f.run();
		expect(csvRows(csv).at(-1)).toMatchObject({
			sessionStatus: "ok",
			cellCount: "3",
			cellP50Ms: "",
			cellP95Ms: "",
			tokensOut: "100",
		});
		expect(summary(stdout, `fixture-model | ${group}`).cellP50).toBe("n/a");
		expect(summary(stdout, `fixture-model | ${group === "A" ? "F" : "A"}`).cellP50).toBe(
			group === "A" ? "20ms" : "10ms",
		);
		expect(stdout).toContain("fixture-model | F: pass 100% vs A 100% OK; tokensOut 100 vs A 100 OK → GO");
	});
	it.each(["A", "F"])("reports no latency sample for %s runs without cells", (group) => {
		const f = fixture();
		f.add({ group, tokensOut: 100 });
		const { stdout, csv } = f.run();
		expect(csvRows(csv)[0]).toMatchObject({ cellCount: "0", cellP50Ms: "", cellP95Ms: "" });
		expect(summary(stdout, `fixture-model | ${group}`).cellP50).toBe("n/a");
	});
	it.each(["A", "F"].flatMap((group) => [0, 0.5].map((duration) => ({ group, duration }))))(
		"preserves valid $group duration $duration",
		({ group, duration }) => {
			const f = fixture();
			const { sessionFile } = f.add({ group, tokensOut: 100, durations: [duration] });
			writeFileSync(
				sessionFile,
				`${readFileSync(sessionFile, "utf-8")}\n${JSON.stringify({
					type: "message",
					message: { role: "toolResult", toolName: "read", details: {} },
				})}`,
			);
			const { stdout, csv } = f.run();
			expect(csvRows(csv)[0]).toMatchObject({
				cellCount: "1",
				cellP50Ms: String(duration),
				cellP95Ms: String(duration),
			});
			expect(summary(stdout, `fixture-model | ${group}`).cellP50).toBe(`${duration}ms`);
		},
	);
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
				taskHash: null,
				providerConfigHash: null,
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
			"  gateway/anthropic/claude-opus-5 | F: task versions incomplete or inconsistent — no verdict",
		);
		expect(stdout).toContain(
			"  gateway/anthropic/claude-sonnet-4-6 | F: task versions incomplete or inconsistent — no verdict",
		);
		expect(overall(stdout)).toContain("F: 0/2 models meet both thresholds; 2 incomplete — no verdict");
	});
});
