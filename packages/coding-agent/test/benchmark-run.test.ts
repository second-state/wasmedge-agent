import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ mode = "ok", config = true, turns = ["first"], check = "exit 0", timeoutMs = 5_000 } = {}) {
	const root = mkdtempSync(join(tmpdir(), "benchmark-run-"));
	roots.push(root);
	const bench = join(root, "poc/bench");
	const task = join(bench, "tasks/fixture");
	const home = join(root, "home");
	const temp = join(root, "tmp");
	for (const dir of [task, join(home, ".wasmedge-agent"), temp]) mkdirSync(dir, { recursive: true });
	for (const name of ["run.ts", "analyze.ts"]) copyFileSync(join(repo, "poc/bench", name), join(bench, name));
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	writeFileSync(join(task, "task.json"), JSON.stringify({ category: "fixture", turns, timeoutMs }));
	writeFileSync(join(task, "check.sh"), check);
	if (config) writeFileSync(join(home, ".wasmedge-agent/models.json"), "{}");
	const fake = join(root, "fake-agent.mjs");
	writeFileSync(
		fake,
		`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const mode = ${JSON.stringify(mode)};
const agentDir = process.env.WASMEDGE_AGENT_CODING_AGENT_DIR;
const marker = ${JSON.stringify(join(root, "first-attempt"))};
console.log("fixture turn");
if (mode === "no-session" || (mode === "fail-first" && !existsSync(marker))) {
  writeFileSync(marker, "attempted");
  process.exit(0);
}
const sessions = join(agentDir, "sessions");
mkdirSync(sessions, { recursive: true });
const message = { type: "message", message: { role: "assistant", usage: { input: 0, output: 100 } } };
appendFileSync(join(sessions, "fixture.jsonl"), JSON.stringify(message) + "\\n");
if (mode === "observe") writeFileSync(join(agentDir, "observed.json"), readFileSync(join(agentDir, "../meta.json")));
if (mode === "remove-after-first") unlinkSync(fileURLToPath(import.meta.url));
if (mode === "block-log") mkdirSync(join(agentDir, "../turn-0.log"));
if (mode === "block-meta") mkdirSync(join(agentDir, "../meta.json.tmp"));
if (mode === "timeout") setInterval(() => {}, 1000);
`,
		{ mode: 0o755 },
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(join(root, "wasmedge-agent.sh"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, {
		mode: 0o755,
	});
	// A copied driver, fake executable, empty provider config, and isolated HOME
	// and TMPDIR keep the real provider and per-user daemon out of these tests.
	const env = {
		PATH: mode === "missing-checker" ? temp : `${dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: home,
		TMPDIR: temp,
		TMP: temp,
		TEMP: temp,
		BENCH_PRIME_AGENT: fake,
	};
	return {
		fake,
		run(reps = 1, group = "A") {
			return spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					join(bench, "run.ts"),
					"--groups",
					group,
					"--models",
					"fixture-model",
					"--reps",
					String(reps),
				],
				{ cwd: root, env, encoding: "utf-8", timeout: 10_000 },
			);
		},
		metas() {
			const runs = join(bench, "results/runs");
			return readdirSync(runs)
				.sort()
				.map((id) => JSON.parse(readFileSync(join(runs, id, "meta.json"), "utf-8")));
		},
		analyze() {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", join(bench, "analyze.ts")], {
				cwd: root,
				env,
				encoding: "utf-8",
				timeout: 10_000,
			});
			expect(result.status, result.stderr).toBe(0);
			return { stdout: result.stdout, csv: readFileSync(join(bench, "results/bench.csv"), "utf-8") };
		},
	};
}

describe("offline benchmark driver", () => {
	it("records setup failures for every attempted run and exits unsuccessfully", () => {
		const f = fixture({ config: false });
		const result = f.run(2);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stdout).toContain("2 failure(s)");
		expect(f.metas()).toHaveLength(2);
		for (const meta of f.metas()) {
			expect(meta).toMatchObject({
				driverStatus: "error",
				checkPass: null,
				wallMs: null,
				sessionFile: null,
				turnExitCodes: [],
			});
			expect(meta.driverError).toContain("provider config");
		}
		expect(f.analyze().stdout).toContain("wrote 2 run(s)");
	});
	it("records an executable spawn failure and its log", () => {
		const f = fixture();
		rmSync(f.fake);
		expect(f.run().status).toBe(1);
		const [meta] = f.metas();
		expect(meta).toMatchObject({ driverStatus: "error", checkPass: null, turnExitCodes: [], sessionFile: null });
		expect(meta.driverError).toContain("ENOENT");
		expect(readFileSync(join(meta.runDir, "turn-0.log"), "utf-8")).toContain("ENOENT");
	});
	it("treats a task-checker spawn failure as a driver error, not a failed task", () => {
		const f = fixture({ mode: "missing-checker" });
		expect(f.run(1, "F").status).toBe(1);
		const [meta] = f.metas();
		expect(meta).toMatchObject({ driverStatus: "error", checkPass: null, turnExitCodes: [0] });
		expect(meta.driverError).toContain("spawn bash ENOENT");
	});
	it.each(["A", "B", "F"])("retains the first %s turn when a later turn has no session to resume", (group) => {
		const f = fixture({ mode: "no-session", turns: ["first", "second"] });
		expect(f.run(1, group).status).toBe(1);
		const [meta] = f.metas();
		expect(meta).toMatchObject({ driverStatus: "error", checkPass: null, sessionFile: null, turnExitCodes: [0] });
		expect(meta.driverError).toContain("no session file to resume");
		expect(meta.wallMs).toBeGreaterThanOrEqual(0);
		expect(readFileSync(join(meta.runDir, "turn-0.log"), "utf-8")).toContain("fixture turn");
	});
	it("records a turn-log write failure instead of crashing before saving metadata", () => {
		const f = fixture({ mode: "block-log" });
		expect(f.run().status).toBe(1);
		const [meta] = f.metas();
		expect(meta).toMatchObject({ driverStatus: "error", checkPass: null });
		expect(meta.driverError).toContain("EISDIR");
		expect(readFileSync(meta.sessionFile, "utf-8")).toContain('"output":100');
	});
	it("preserves the initial JSON record when a checkpoint cannot be written", () => {
		const f = fixture({ mode: "block-meta" });
		const result = f.run();
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("DRIVER-ERROR");
		expect(f.metas()[0]).toMatchObject({ driverStatus: "running", checkPass: null, wallMs: null });
		expect(f.analyze().stdout).toContain("wrote 1 run(s)");
	});
	it("retains partial session evidence if a later turn cannot start", () => {
		const f = fixture({ mode: "remove-after-first", turns: ["first", "second"] });
		expect(f.run().status).toBe(1);
		const [meta] = f.metas();
		expect(meta).toMatchObject({ driverStatus: "error", checkPass: null, turnExitCodes: [0] });
		expect(meta.driverError).toContain("ENOENT");
		expect(readFileSync(meta.sessionFile, "utf-8")).toContain('"output":100');
		const { csv, stdout } = f.analyze();
		expect(csv).toContain(",error");
		expect(stdout).toContain("wrote 1 run(s)");
	});
	it("continues to later repetitions after a recorded driver failure", () => {
		const f = fixture({ mode: "fail-first", turns: ["first", "second"] });
		const result = f.run(2);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stdout).toContain("1 run(s) complete. 1 failure(s)");
		expect(f.metas().map((meta) => [meta.driverStatus, meta.checkPass])).toEqual([
			["error", null],
			["completed", true],
		]);
		expect(f.analyze().stdout).toContain("wrote 2 run(s)");
	});
	it("writes the initial record before launching the agent and completes it after checking", () => {
		const f = fixture({ mode: "observe", turns: ["first", "second"] });
		expect(f.run().status).toBe(0);
		const [meta] = f.metas();
		expect(meta).toMatchObject({
			driverStatus: "completed",
			driverError: null,
			checkPass: true,
			turnExitCodes: [0, 0],
		});
		const observed = JSON.parse(readFileSync(join(meta.runDir, "agent-dir/observed.json"), "utf-8"));
		expect(observed).toMatchObject({ driverStatus: "running", checkPass: null, turnExitCodes: [0] });
		expect(f.analyze().csv).toContain(",completed");
	});
	it("keeps a parseable incomplete record if the driver is killed during task checking", () => {
		const f = fixture({ check: 'kill -KILL "$PPID"' });
		const result = f.run();
		expect(result.signal).toBe("SIGKILL");
		const [meta] = f.metas();
		expect(meta).toMatchObject({ driverStatus: "running", checkPass: null, turnExitCodes: [0] });
		expect(readFileSync(meta.sessionFile, "utf-8")).toContain('"output":100');
		expect(f.analyze().csv).toContain(",running");
	});
	it("keeps a task timeout distinct from a driver error", () => {
		const f = fixture({ mode: "timeout", timeoutMs: 1_000, check: "exit 1" });
		const result = f.run();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("TIMEOUT");
		expect(f.metas()[0]).toMatchObject({
			driverStatus: "completed",
			driverError: null,
			timedOut: true,
			checkPass: false,
			turnExitCodes: [-1],
		});
	});
});
