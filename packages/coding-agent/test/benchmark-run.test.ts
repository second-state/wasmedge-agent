import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		const events = join(root, "daemon-events.jsonl");
		if (existsSync(events)) {
			for (const line of readFileSync(events, "utf-8").trim().split("\n")) {
				const event = JSON.parse(line);
				if (event.socketPath?.startsWith("/tmp/wasmedge-bench-"))
					rmSync(dirname(event.socketPath), { recursive: true, force: true });
			}
		}
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture({ mode = "ok", config = true, turns = ["first"], check = "exit 0", timeoutMs = 5_000 } = {}) {
	const root = mkdtempSync(join(tmpdir(), "benchmark-run-"));
	roots.push(root);
	const bench = join(root, "poc/bench");
	const task = join(bench, "tasks/fixture");
	const home = join(root, "home");
	const temp = join(root, "tmp");
	for (const dir of [task, join(home, ".wasmedge-agent"), temp]) mkdirSync(dir, { recursive: true });
	for (const name of ["run.ts", "analyze.ts", "launchers.ts"])
		copyFileSync(join(repo, "poc/bench", name), join(bench, name));
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	writeFileSync(join(task, "task.json"), JSON.stringify({ category: "fixture", turns, timeoutMs }));
	writeFileSync(join(task, "check.sh"), check);
	if (config) writeFileSync(join(home, ".wasmedge-agent/models.json"), "{}");
	const fake = join(root, "fake-agent.mjs");
	writeFileSync(
		fake,
		`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
const mode = ${JSON.stringify(mode)};
const agentDir = process.env.WASMEDGE_AGENT_CODING_AGENT_DIR;
const marker = ${JSON.stringify(join(root, "first-attempt"))};
const events = ${JSON.stringify(join(root, "daemon-events.jsonl"))};
const socketPath = process.argv[process.argv.indexOf("--daemon-socket") + 1];
const record = (event) => appendFileSync(events, JSON.stringify({ event, socketPath, pid: process.pid }) + "\\n");
if (process.argv.includes("daemon")) {
  record("start");
  if (mode === "edit-launcher-on-start") {
    const meta = JSON.parse(readFileSync(join(agentDir, "../meta.json"), "utf-8"));
    appendFileSync(meta.launcherPath, "\\n");
  }
  if (mode === "edit-provider-on-start") writeFileSync(join(agentDir, "models.json"), "{}");
  if (mode === "observe-plan") {
    const runs = join(agentDir, "../..");
    writeFileSync(${JSON.stringify(join(root, "plan-at-start.json"))}, JSON.stringify(readdirSync(runs).map((id) => JSON.parse(readFileSync(join(runs, id, "meta.json"), "utf-8")))));
    const plans = join(runs, "../plans");
    writeFileSync(${JSON.stringify(join(root, "manifest-at-start.json"))}, readFileSync(join(plans, readdirSync(plans)[0])));
  }
  if (mode === "daemon-fail") process.exit(2);
  const ready = mode === "slow-ready" ? new Promise((resolve) => setTimeout(() => { record("ready"); resolve(); }, 2_200)) : Promise.resolve();
  const server = createServer((socket) => {
    socket.on("error", () => {});
    const protocol = { name: "prime-agent.daemon", version: mode === "bad-protocol" ? 6 : 7 };
    ready.then(() => { if (!socket.destroyed) socket.write(JSON.stringify({ type: "daemon_hello", protocol }) + "\\n"); });
    socket.on("data", (data) => {
      const envelope = JSON.parse(data.toString());
      if (envelope.type !== "command" || envelope.protocol?.version !== 7 || envelope.command?.type !== "shutdown" || envelope.command.force !== true) process.exit(3);
      record("stop");
      socket.end(JSON.stringify({ type: "response", id: envelope.id, success: mode !== "reject-shutdown" }) + "\\n");
      if (mode !== "reject-shutdown") server.close(() => process.exit(mode === "failed-shutdown" ? 2 : 0));
    });
  });
  process.on("SIGTERM", () => {
    record("signal-stop");
    server.close(() => process.exit(0));
  });
  if (mode === "daemon-timeout") setInterval(() => {}, 1000);
  else server.listen(socketPath);
} else {
record("turn");
console.log("fixture turn");
if (mode === "edit-launcher-turn") {
  const meta = JSON.parse(readFileSync(join(agentDir, "../meta.json"), "utf-8"));
  appendFileSync(meta.launcherPath, "\\n");
}
if (mode === "resume-while-running") {
  const meta = JSON.parse(readFileSync(join(agentDir, "../meta.json"), "utf-8"));
  const attempt = spawnSync(process.execPath, ["--experimental-strip-types", ${JSON.stringify(join(bench, "run.ts"))}, "--resume-plan", meta.planId], { encoding: "utf-8", timeout: 2000 });
  writeFileSync(join(agentDir, "resume-attempt.json"), JSON.stringify({ status: attempt.status, stderr: attempt.stderr }));
}
if (mode === "no-session" || (mode === "fail-first" && !existsSync(marker))) {
  writeFileSync(marker, "attempted");
  process.exit(0);
}
const sessions = join(agentDir, "sessions");
mkdirSync(sessions, { recursive: true });
const message = { type: "message", message: { role: "assistant", usage: { input: 0, output: 100 } } };
appendFileSync(join(sessions, "fixture.jsonl"), JSON.stringify(message) + "\\n");
if (mode === "observe") writeFileSync(join(agentDir, "observed.json"), readFileSync(join(agentDir, "../meta.json")));
if (mode === "edit-task-source") {
  appendFileSync(join(agentDir, "observed.jsonl"), JSON.stringify({ prompt: process.argv.at(-1), input: readFileSync("input.txt", "utf-8") }) + "\\n");
  const task = ${JSON.stringify(task)};
  writeFileSync(join(task, "task.json"), JSON.stringify({ category: "changed", turns: ["changed"] }));
  writeFileSync(join(task, "fixture/input.txt"), "changed");
  writeFileSync(join(task, "check.sh"), "exit 1");
}
if (mode === "edit-task-snapshot") writeFileSync(join(agentDir, "../task/check.sh"), "exit 0");
if (mode === "edit-provider-source") {
  appendFileSync(join(agentDir, "observed-config.jsonl"), readFileSync(join(agentDir, "models.json"), "utf-8") + "\\n");
  writeFileSync(${JSON.stringify(join(home, ".wasmedge-agent/models.json"))}, '{"changed":true}');
}
if (mode === "edit-provider-active") writeFileSync(join(agentDir, "models.json"), "{}");
if (mode === "edit-provider-snapshot") writeFileSync(join(agentDir, "../models.json"), "{}");
if (mode === "edit-planned-provider-snapshot") {
  for (const id of readdirSync(join(agentDir, "../.."))) {
    const runDir = join(agentDir, "../..", id);
    if (JSON.parse(readFileSync(join(runDir, "meta.json"), "utf-8")).driverStatus === "planned") {
      writeFileSync(join(runDir, "models.json"), "{}");
    }
  }
}
if (mode === "edit-planned-snapshot") {
  const runs = join(agentDir, "../..");
  for (const id of readdirSync(runs)) {
    if (JSON.parse(readFileSync(join(runs, id, "meta.json"), "utf-8")).driverStatus === "planned") {
      writeFileSync(join(runs, id, "task/check.sh"), "exit 1");
    }
  }
}
if (mode === "remove-after-first") unlinkSync(fileURLToPath(import.meta.url));
if (mode === "block-log") mkdirSync(join(agentDir, "../turn-0.log"));
if (mode === "block-meta") mkdirSync(join(agentDir, "../meta.json.tmp"));
if (mode === "timeout") setInterval(() => {}, 1000);
}
`,
		{ mode: 0o755 },
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const realDaemon =
		mode === "real-daemon"
			? `if [ "$1" = "--mode" ]; then exec ${quote(join(repo, "wasmedge-agent.sh"))} "$@"; fi\n`
			: "";
	writeFileSync(
		join(root, "wasmedge-agent.sh"),
		`#!/bin/sh\n${realDaemon}exec ${quote(process.execPath)} ${quote(fake)} "$@"\n`,
		{
			mode: 0o755,
		},
	);
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
		fork: join(realpathSync(root), "wasmedge-agent.sh"),
		env,
		temp,
		plansDir: join(bench, "results/plans"),
		locksDir: join(bench, "results/locks"),
		configPath: join(home, ".wasmedge-agent/models.json"),
		legacyConfigPath: join(home, ".prime/agent/models.json"),
		taskDir: task,
		addTask(id: string, spec?: unknown) {
			const dir = join(bench, "tasks", id);
			mkdirSync(dir);
			writeFileSync(join(dir, "task.json"), JSON.stringify(spec ?? { category: "fixture", turns, timeoutMs }));
			copyFileSync(join(task, "check.sh"), join(dir, "check.sh"));
		},
		planAtStart() {
			return JSON.parse(readFileSync(join(root, "plan-at-start.json"), "utf-8"));
		},
		manifestAtStart() {
			return JSON.parse(readFileSync(join(root, "manifest-at-start.json"), "utf-8"));
		},
		hasEvents() {
			return existsSync(join(root, "daemon-events.jsonl"));
		},
		events() {
			return readFileSync(join(root, "daemon-events.jsonl"), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		},
		run(reps = 1, group = "A", extraArgs: string[] = []) {
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
					...extraArgs,
				],
				{ cwd: root, env, encoding: "utf-8", timeout: mode === "real-daemon" ? 30_000 : 10_000 },
			);
		},
		resume(planId: string, extraArgs: string[] = []) {
			return spawnSync(
				process.execPath,
				["--experimental-strip-types", join(bench, "run.ts"), "--resume-plan", planId, ...extraArgs],
				{ cwd: root, env, encoding: "utf-8", timeout: 10_000 },
			);
		},
		metas() {
			const runs = join(bench, "results/runs");
			if (!existsSync(runs)) return [];
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
	it("compares unchanged task inputs across separate invocations", () => {
		const f = fixture();
		expect(f.run(1, "A").status).toBe(0);
		expect(f.run(1, "F").status).toBe(0);
		expect(new Set(f.metas().map((meta) => meta.taskHash)).size).toBe(1);
		expect(new Set(f.metas().map((meta) => meta.providerConfigHash)).size).toBe(1);
		expect(new Set(f.metas().map((meta) => meta.planId)).size).toBe(2);
		expect(readdirSync(f.plansDir)).toHaveLength(2);
		expect(f.analyze().stdout).toContain("fixture-model | F: pass 100% vs A 100% OK; tokensOut 100 vs A 100 OK → GO");
	});
	it("detects missing model records using the driver's saved inventory", () => {
		const f = fixture();
		const result = f.run(1, "A,F", ["--models", "model-a,model-b,model-c"]);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(f.analyze().stdout).toContain("F: 3/3 models meet both thresholds → GO");
		for (const meta of f.metas().filter((meta) => meta.model === "model-c")) {
			rmSync(meta.runDir, { recursive: true });
		}
		const { stdout, csv } = f.analyze();
		expect(stdout).toContain("Run inventory: 4/6 planned records match");
		expect(stdout).toContain("F: run inventory incomplete or inconsistent — no verdict");
		expect(stdout).not.toMatch(/→ (GO|NO-GO)/);
		expect(csv.split("\n")).toHaveLength(5);
	});
	it("does not launch an agent when the inventory cannot be saved", () => {
		const f = fixture();
		mkdirSync(dirname(f.plansDir), { recursive: true });
		writeFileSync(f.plansDir, "not a directory");
		expect(f.run().status).toBe(1);
		expect(f.hasEvents()).toBe(false);
		expect(f.metas()[0]).toMatchObject({ driverStatus: "planned", startedAt: null });
	});
	it("uses the same planned provider config after the seed changes during a run", () => {
		const f = fixture({ mode: "edit-provider-source", turns: ["first", "second"] });
		const source = '{"providers":{"fixture":{"apiKey":"fixture-only-secret"}}}';
		writeFileSync(f.configPath, source);
		const result = f.run(1, "A,B,F");
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout + result.stderr).not.toContain("fixture-only-secret");
		expect(readFileSync(f.configPath, "utf-8")).toBe('{"changed":true}');
		expect(new Set(f.metas().map((meta) => meta.providerConfigHash)).size).toBe(1);
		for (const meta of f.metas()) {
			expect(meta).toMatchObject({ driverStatus: "completed", checkPass: true });
			expect(meta.providerConfigHash).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(JSON.stringify(meta)).not.toContain("fixture-only-secret");
			for (const file of ["models.json", "agent-dir/models.json"]) {
				const path = join(meta.runDir, file);
				expect(readFileSync(path, "utf-8")).toBe(source);
				expect(statSync(path).mode & 0o777).toBe(0o600);
			}
			expect(readFileSync(join(meta.runDir, "agent-dir/observed-config.jsonl"), "utf-8")).toBe(
				`${source}\n${source}\n`,
			);
		}
		expect(f.analyze().stdout).toContain("fixture-model | F: pass 100% vs A 100% OK; tokensOut 200 vs A 200 OK → GO");
	});
	it("withholds comparisons after the provider seed changes between invocations", () => {
		const f = fixture();
		expect(f.run(1, "A").status).toBe(0);
		writeFileSync(f.configPath, '{"providers":{}}');
		expect(f.run(1, "F").status).toBe(0);
		expect(new Set(f.metas().map((meta) => meta.providerConfigHash)).size).toBe(2);
		expect(f.analyze().stdout).toContain("provider configs differ — no verdict");
	});
	it.each(["edit-provider-on-start", "edit-provider-active", "edit-provider-snapshot"])(
		"rejects %s before proceeding to another turn or task checking",
		(mode) => {
			const f = fixture({ mode, turns: ["first", "second"], check: 'touch "$PROJECT_DIR/checked"' });
			writeFileSync(f.configPath, '{"providers":{}}');
			expect(f.run().status).toBe(1);
			const [meta] = f.metas();
			expect(meta).toMatchObject({
				driverStatus: "error",
				checkPass: null,
				driverError: "benchmark provider config changed after planning",
				turnExitCodes: mode === "edit-provider-on-start" ? [] : [0],
			});
			expect(f.events().at(-1).event).toBe("stop");
			expect(existsSync(join(meta.runDir, "project/checked"))).toBe(false);
		},
	);
	it("rejects a changed provider snapshot for a later run before launching its daemon", () => {
		const f = fixture({ mode: "edit-planned-provider-snapshot" });
		writeFileSync(f.configPath, '{"providers":{}}');
		expect(f.run(2).status).toBe(1);
		expect(f.metas().find((meta) => meta.rep === 2)).toMatchObject({
			driverStatus: "error",
			driverError: "benchmark provider config changed after planning",
			daemonPid: null,
			wallMs: null,
			checkPass: null,
		});
		expect(f.events().filter((event) => event.event === "start")).toHaveLength(1);
	});
	it.each(["models.json", "agent-dir/models.json"])("rejects checker changes to %s", (path) => {
		const f = fixture({ check: `printf '{}' > "$PROJECT_DIR/../${path}"` });
		writeFileSync(f.configPath, '{"providers":{}}');
		expect(f.run().status).toBe(1);
		expect(f.metas()[0]).toMatchObject({
			driverStatus: "error",
			driverError: "benchmark provider config changed after planning",
			checkPass: null,
		});
	});
	it.each(['{"apiKey":"fixture-only-secret", broken}', "null", "[]", "42"])(
		"rejects malformed provider config before planning without disclosing its content: %s",
		(source) => {
			const f = fixture();
			writeFileSync(f.configPath, source);
			const result = f.run();
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("invalid provider config: expected a JSON object");
			expect(result.stderr).not.toContain("fixture-only-secret");
			expect(f.metas()).toEqual([]);
			expect(f.hasEvents()).toBe(false);
		},
	);
	it("snapshots the legacy provider config when the fork config is absent", () => {
		const f = fixture({ config: false });
		mkdirSync(dirname(f.legacyConfigPath), { recursive: true });
		writeFileSync(f.legacyConfigPath, '{"providers":{}}');
		expect(f.run().status).toBe(0);
		expect(readFileSync(join(f.metas()[0].runDir, "models.json"), "utf-8")).toBe('{"providers":{}}');
	});
	it("preserves supported comments, trailing commas, and string contents in config snapshots", () => {
		const f = fixture();
		const source = `{
  // A provider config accepted by the model registry.
  "providers": {
    "fixture": {
      "baseUrl": "https://fixture.invalid/v1",
      "apiKey": "contains // and ,} and \\"quoted\\" text",
      "models": [{"id": "fixture",},],
    },
  },
}`;
		writeFileSync(f.configPath, source);
		const result = f.run(1, "A,F");
		expect(result.status, result.stderr).toBe(0);
		for (const meta of f.metas()) {
			expect(readFileSync(join(meta.runDir, "models.json"), "utf-8")).toBe(source);
			expect(readFileSync(join(meta.runDir, "agent-dir/models.json"), "utf-8")).toBe(source);
		}
		expect(f.analyze().stdout).toContain("fixture-model | F: pass 100% vs A 100% OK; tokensOut 100 vs A 100 OK → GO");
	});
	it("uses planned task snapshots after the original prompts, fixture and checker change", () => {
		const f = fixture({
			mode: "edit-task-source",
			turns: ["first", "second"],
			check: 'test "$(cat "$PROJECT_DIR/input.txt")" = original',
		});
		mkdirSync(join(f.taskDir, "fixture"));
		writeFileSync(join(f.taskDir, "fixture/input.txt"), "original");
		// A task input named meta.json must not be mistaken for a benchmark run.
		writeFileSync(join(f.taskDir, "meta.json"), "not run metadata");
		const result = f.run(1, "A,B,F");
		expect(result.status, result.stdout + result.stderr).toBe(0);
		const metas = f.metas();
		expect(metas).toHaveLength(3);
		expect(new Set(metas.map((meta) => meta.taskHash)).size).toBe(1);
		for (const meta of metas) {
			expect(meta).toMatchObject({ driverStatus: "completed", checkPass: true, category: "fixture" });
			expect(meta.taskHash).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(meta.providerConfigHash).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(readFileSync(join(meta.runDir, "models.json"), "utf-8")).toBe("{}");
			expect(readFileSync(join(meta.runDir, "task/fixture/input.txt"), "utf-8")).toBe("original");
			expect(
				readFileSync(join(meta.runDir, "agent-dir/observed.jsonl"), "utf-8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			).toEqual([
				{ prompt: "first", input: "original" },
				{ prompt: "second", input: "original" },
			]);
		}
		expect(f.analyze().stdout).toContain("wrote 3 run(s)");
	});
	it.each(["prompt", "timeout", "fixture", "checker", "helper", "executable"])(
		"records a new hash when the %s changes",
		(part) => {
			const f = fixture();
			mkdirSync(join(f.taskDir, "fixture"));
			writeFileSync(join(f.taskDir, "fixture/input.txt"), "original");
			expect(f.run(1, "A").status).toBe(0);
			const original = f.metas()[0].taskHash;
			if (part === "prompt" || part === "timeout") {
				const path = join(f.taskDir, "task.json");
				const spec = JSON.parse(readFileSync(path, "utf-8"));
				if (part === "prompt") spec.turns = ["changed"];
				else spec.timeoutMs += 1;
				writeFileSync(path, JSON.stringify(spec));
			} else if (part === "executable") chmodSync(join(f.taskDir, "fixture/input.txt"), 0o755);
			else
				writeFileSync(
					join(
						f.taskDir,
						part === "fixture" ? "fixture/input.txt" : part === "checker" ? "check.sh" : "helper.txt",
					),
					part === "checker" ? "exit 0\n" : "changed",
				);
			expect(f.run(1, "F").status).toBe(0);
			const changed = f.metas().find((meta) => meta.group === "F");
			expect(changed.taskHash).not.toBe(original);
			expect(f.analyze().stdout).toContain("task versions differ — no verdict");
		},
	);
	it.each(["edit-task-snapshot", "checker"])("records %s changes to the snapshot as a driver error", (mode) => {
		const f = fixture({ mode, check: mode === "checker" ? 'printf "changed" > helper.txt' : "exit 1" });
		expect(f.run().status).toBe(1);
		expect(f.metas()[0]).toMatchObject({
			driverStatus: "error",
			checkPass: null,
			driverError: "benchmark task inputs changed after planning",
		});
	});
	it("rejects a modified planned snapshot before starting its daemon", () => {
		const f = fixture({ mode: "edit-planned-snapshot" });
		expect(f.run(2).status).toBe(1);
		expect(f.metas().find((meta) => meta.rep === 2)).toMatchObject({
			driverStatus: "error",
			checkPass: null,
			daemonPid: null,
			wallMs: null,
		});
		expect(f.events().filter((event) => event.event === "start")).toHaveLength(1);
	});
	it("rejects symlink task inputs before launching an agent", () => {
		const f = fixture();
		symlinkSync("check.sh", join(f.taskDir, "linked-check"));
		const result = f.run();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("task inputs must be regular files or directories");
		expect(f.hasEvents()).toBe(false);
	});
	it("registers the full matrix before launch and retains unstarted runs after interruption", () => {
		const f = fixture({ mode: "observe-plan", check: 'kill -KILL "$PPID"' });
		f.addTask("second");
		const result = f.run(3, "A,B,F", ["--models", "provider-one/shared,provider-two/shared", "--variant", "split"]);
		expect(result.signal).toBe("SIGKILL");
		const before = f.planAtStart();
		const manifest = f.manifestAtStart();
		const metas = f.metas();
		expect(manifest).toMatchObject({ version: 1, planId: metas[0].planId });
		expect(Number.isFinite(Date.parse(manifest.plannedAt))).toBe(true);
		expect(manifest.runs).toHaveLength(36);
		expect(new Set(metas.map((meta) => meta.planId)).size).toBe(1);
		for (const slot of manifest.runs) {
			expect(before.find((meta: { runId: string }) => meta.runId === slot.runId)).toMatchObject(slot);
		}
		expect(readdirSync(f.plansDir)).toEqual([`${manifest.planId}.json`]);
		expect(before).toHaveLength(36);
		expect(metas).toHaveLength(36);
		expect(new Set(metas.map((meta) => meta.runId)).size).toBe(36);
		expect(before.filter((meta: { driverStatus: string }) => meta.driverStatus === "running")).toHaveLength(1);
		const planned = metas.filter((meta) => meta.driverStatus === "planned");
		expect(planned).toHaveLength(35);
		for (const meta of planned) {
			expect(meta).toMatchObject({
				startedAt: null,
				wallMs: null,
				daemonSocket: null,
				daemonPid: null,
				checkPass: null,
				sessionFile: null,
				turnExitCodes: [],
			});
			expect(typeof meta.plannedAt).toBe("string");
			expect(meta.taskHash).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(meta.providerConfigHash).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(readFileSync(join(meta.runDir, "models.json"), "utf-8")).toBe("{}");
		}
		for (const task of ["fixture", "second"]) {
			for (const model of ["provider-one/shared", "provider-two/shared"]) {
				const slots = metas.filter((meta) => meta.task === task && meta.model === model);
				for (const group of ["A", "B", "F"]) {
					const groupSlots = slots.filter((meta) => meta.group === group).sort((a, b) => a.rep - b.rep);
					expect(groupSlots.map((meta) => meta.rep)).toEqual([1, 2, 3]);
					expect(groupSlots.map((meta) => meta.variant)).toEqual(
						group === "B"
							? ["example", "noexample", "example"]
							: Array(3).fill(group === "A" ? "n/a" : "builtin"),
					);
				}
			}
		}
		const { stdout, csv } = f.analyze();
		expect(stdout).toContain("wrote 36 run(s)");
		expect(stdout).toContain("driver runs incomplete — no verdict");
		expect(stdout).not.toContain("→ GO");
		expect(csv.split("\n").filter((line) => line.includes(",planned,"))).toHaveLength(35);
	});
	it("validates later tasks before launching any selected task", () => {
		const f = fixture();
		f.addTask("second", { category: "fixture", turns: [] });
		const result = f.run();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("invalid task specification: second");
		expect(f.hasEvents()).toBe(false);
		expect(f.metas()).toEqual([]);
	});
	it("does not launch an agent if a later plan record cannot be created", () => {
		const f = fixture();
		const result = f.run(1, "A", ["--models", `first,${"x".repeat(256)}`]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("ENAMETOOLONG");
		expect(f.hasEvents()).toBe(false);
		expect(f.metas()).toHaveLength(1);
		expect(f.metas()[0]).toMatchObject({ driverStatus: "planned", startedAt: null, checkPass: null });
		expect(f.analyze().stdout).toContain("missing or invalid plan for run");
	});
	it.each([
		["--reps", "0"],
		["--reps", "-1"],
		["--reps", "1.5"],
		["--reps", "Infinity"],
		["--groups", "A,A"],
		["--groups", "A,Z"],
		["--models", "one,"],
		["--variant", "unknown"],
		["--reps"],
	])("rejects an invalid run selection %j before launch", (...args) => {
		const f = fixture();
		expect(f.run(1, "A", args).status).toBe(1);
		expect(f.hasEvents()).toBe(false);
		expect(f.metas()).toEqual([]);
	});
	it.each(["A", "B", "F"])("uses a private %s daemon for each run and stops it after all turns", (group) => {
		const f = fixture({ turns: ["first", "second"] });
		expect(f.run(2, group).status).toBe(0);
		const metas = f.metas();
		expect(new Set(metas.map((meta) => meta.daemonSocket)).size).toBe(2);
		for (const meta of metas) {
			const events = f.events().filter((event) => event.socketPath === meta.daemonSocket);
			expect(events.map((event) => event.event)).toEqual(["start", "turn", "turn", "stop"]);
			expect(events[0].pid).toBe(meta.daemonPid);
			expect(existsSync(dirname(meta.daemonSocket))).toBe(false);
		}
	});
	it("does not inspect or remove either shared socket directory", () => {
		const f = fixture();
		const shared = ["prime-agent", "wasmedge-agent"].map((name) =>
			join(f.temp, `${name}-${process.getuid?.() ?? "0"}`, "daemon.sock"),
		);
		for (const path of shared) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "unrelated socket sentinel");
		}
		expect(f.run().status).toBe(0);
		for (const path of shared) expect(readFileSync(path, "utf-8")).toBe("unrelated socket sentinel");
	});
	it("starts and shuts down the real fork daemon without making model requests", () => {
		const f = fixture({ mode: "real-daemon", timeoutMs: 15_000 });
		const result = f.run(1, "F");
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const [meta] = f.metas();
		expect(meta).toMatchObject({ driverStatus: "completed", checkPass: true });
		expect(existsSync(dirname(meta.daemonSocket))).toBe(false);
	});
	it("reports shutdown rejection and retains its private directory", () => {
		const f = fixture({ mode: "reject-shutdown" });
		expect(f.run().status).toBe(1);
		const [meta] = f.metas();
		expect(meta).toMatchObject({ driverStatus: "error", checkPass: null });
		expect(meta.driverError).toContain("rejected shutdown");
		expect(existsSync(dirname(meta.daemonSocket))).toBe(true);
		expect(f.events().at(-1).event).toBe("signal-stop");
	});
	it("reports an unsupported protocol without sending a shutdown command", () => {
		const f = fixture({ mode: "bad-protocol" });
		expect(f.run().status).toBe(1);
		expect(f.metas()[0].driverError).toContain("unsupported benchmark daemon protocol");
		expect(f.events().map((event) => event.event)).toEqual(["start", "signal-stop"]);
	});
	it("waits for initialization after the daemon socket starts listening", () => {
		const f = fixture({ mode: "slow-ready" });
		const result = f.run();
		expect(result.status, result.stdout).toBe(0);
		expect(f.events().map((event) => event.event)).toEqual(["start", "ready", "turn", "stop"]);
	});
	it("records a daemon failure after the shutdown acknowledgement", () => {
		const f = fixture({ mode: "failed-shutdown" });
		expect(f.run().status).toBe(1);
		expect(f.metas()[0]).toMatchObject({ driverStatus: "error", checkPass: null });
		expect(f.metas()[0].driverError).toContain("failed during shutdown");
	});
	it.each(["daemon-fail", "daemon-timeout"])("records %s without running task turns", (mode) => {
		const f = fixture({ mode, timeoutMs: 1_000 });
		expect(f.run().status).toBe(1);
		const [meta] = f.metas();
		expect(meta).toMatchObject({ driverStatus: "error", checkPass: null, turnExitCodes: [] });
		expect(meta.driverError).toContain(mode === "daemon-fail" ? "before readiness" : "startup timed out");
		expect(f.events().some((event) => event.event === "turn")).toBe(false);
		expect(existsSync(dirname(meta.daemonSocket))).toBe(false);
	});
	it("rejects a missing provider config before planning or launching any agent", () => {
		const f = fixture({ config: false });
		const result = f.run(2);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("provider config");
		expect(f.metas()).toEqual([]);
		expect(f.hasEvents()).toBe(false);
	});
	it("records an interpreter spawn failure and its log", () => {
		const f = fixture();
		writeFileSync(f.fake, "#!/nonexistent-benchmark-interpreter\n");
		expect(f.run().status).toBe(1);
		const [meta] = f.metas();
		expect(meta).toMatchObject({ driverStatus: "error", checkPass: null, turnExitCodes: [], sessionFile: null });
		expect(meta.driverError).toContain("ENOENT");
		expect(readFileSync(join(meta.runDir, "daemon.log"), "utf-8")).toContain("ENOENT");
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
		expect(meta.driverError).toContain("agent launcher changed or is unavailable");
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
		expect(Date.parse(meta.startedAt)).toBeGreaterThanOrEqual(Date.parse(meta.plannedAt));
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

describe("benchmark agent launcher pins", () => {
	it("records the selected executable path, symlink target, and file bytes for all groups", () => {
		const f = fixture();
		const result = f.run(1, "A,B,F", ["--plan-only"]);
		expect(result.status, result.stderr).toBe(0);
		for (const meta of f.metas()) {
			const path = meta.group === "F" ? f.fork : f.fake;
			expect(meta).toMatchObject({
				launcherPath: path,
				launcherRealPath: realpathSync(path),
				launcherHash: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
			});
			const plan = JSON.parse(readFileSync(join(f.plansDir, `${meta.planId}.json`), "utf-8"));
			expect(plan.launcherPinVersion).toBe(1);
			expect(plan.runs.find((slot: { runId: string }) => slot.runId === meta.runId)).toMatchObject({
				launcherPath: meta.launcherPath,
				launcherRealPath: meta.launcherRealPath,
				launcherHash: meta.launcherHash,
			});
		}
		expect(f.hasEvents()).toBe(false);
	});

	it("resolves PATH once and resumes the pinned invocation path instead of the current override", () => {
		const f = fixture();
		const entry = join(dirname(f.fake), "bench-agent");
		symlinkSync(f.fake, entry);
		mkdirSync(join(f.temp, "bench-agent"));
		f.env.PATH = `${f.temp}:${dirname(f.fake)}:${f.env.PATH}`;
		f.env.BENCH_PRIME_AGENT = "bench-agent";
		expect(f.run(1, "A", ["--plan-only"]).status).toBe(0);
		const [meta] = f.metas();
		expect(meta.launcherPath).toBe(entry);
		expect(meta.launcherRealPath).toBe(realpathSync(f.fake));
		f.env.BENCH_PRIME_AGENT = "missing-new-override";
		f.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
		const result = f.resume(meta.planId);
		expect(result.status, result.stderr).toBe(0);
		expect(f.metas()[0]).toMatchObject({ driverStatus: "completed", checkPass: true, launcherPath: entry });
	});

	it.each(["missing", "not executable", "directory"])("rejects a %s launcher before planning any run", (problem) => {
		const f = fixture();
		if (problem === "not executable") chmodSync(f.fork, 0o644);
		else {
			rmSync(f.fork);
			if (problem === "directory") mkdirSync(f.fork);
		}
		const result = f.run(1, "A,F", ["--plan-only"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("agent launcher is missing, unreadable, or not executable");
		expect(f.metas()).toEqual([]);
		expect(f.hasEvents()).toBe(false);
	});

	it.each(["bytes", "target", "permission", "missing"])(
		"rejects changed %s in a later pending launcher before any execution",
		(problem) => {
			const f = fixture();
			const original = readFileSync(f.fork);
			expect(f.run(1, "A,F", ["--plan-only"]).status).toBe(0);
			const before = f.metas();
			if (problem === "bytes") appendFileSync(f.fork, "\n");
			if (problem === "permission") chmodSync(f.fork, 0o644);
			if (problem === "missing") rmSync(f.fork);
			if (problem === "target") {
				const replacement = join(f.temp, "replacement.sh");
				writeFileSync(replacement, original, { mode: 0o755 });
				rmSync(f.fork);
				symlinkSync(replacement, f.fork);
			}
			const result = f.resume(before[0].planId);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("agent launcher changed or is unavailable");
			expect(f.hasEvents()).toBe(false);
			expect(f.metas()).toEqual(before);
		},
	);

	it.each(["A", "B", "F"])("detects changed %s launchers before another client or repetition runs", (group) => {
		for (const mode of ["edit-launcher-on-start", "edit-launcher-turn"]) {
			const f = fixture({ mode, turns: ["first", "second"], check: 'touch "$PROJECT_DIR/checked"' });
			const result = f.run(2, group);
			expect(result.status, result.stdout + result.stderr).toBe(1);
			const metas = f.metas();
			for (const meta of metas) {
				expect(meta).toMatchObject({ driverStatus: "error", checkPass: null });
				expect(meta.driverError).toContain("agent launcher changed or is unavailable");
				expect(existsSync(join(meta.runDir, "project/checked"))).toBe(false);
			}
			expect(metas.find((meta) => meta.rep === 2).daemonPid).toBeNull();
			expect(f.events().map((event) => event.event)).toEqual(
				mode === "edit-launcher-on-start" ? ["start", "stop"] : ["start", "turn", "stop"],
			);
		}
	});

	it("does not accept task checks that change the launcher", () => {
		const f = fixture({
			check: `node <<'JS'
const fs = require("node:fs");
const meta = JSON.parse(fs.readFileSync(process.env.PROJECT_DIR + "/../meta.json", "utf-8"));
fs.appendFileSync(meta.launcherPath, "\\n");
JS`,
		});
		expect(f.run().status).toBe(1);
		expect(f.metas()[0]).toMatchObject({ driverStatus: "error", checkPass: null });
		expect(f.metas()[0].driverError).toContain("agent launcher changed or is unavailable");
	});

	it("retains completed evidence without requiring its launcher to remain installed", () => {
		const f = fixture();
		expect(f.run().status).toBe(0);
		const [meta] = f.metas();
		rmSync(f.fake);
		expect(f.resume(meta.planId).status).toBe(0);
		expect(f.metas()[0]).toEqual(meta);
		expect(f.analyze().stdout).toContain("Agent launcher pins: 1/1 records");
	});

	it("withholds comparisons that pool different recorded launchers within a condition", () => {
		const f = fixture();
		expect(f.run(1, "A,F").status).toBe(0);
		appendFileSync(f.fork, "\n");
		expect(f.run(1, "A,F").status).toBe(0);
		const { stdout, csv } = f.analyze();
		expect(stdout).toContain("agent launcher fingerprints incomplete or inconsistent — no verdict");
		expect(stdout).not.toContain("→ GO");
		expect(csv.split("\n")[0].endsWith(",launcherHash")).toBe(true);
		for (const meta of f.metas()) expect(csv).toContain(meta.launcherHash);
	});

	it("leaves unpinned legacy plans analyzable but does not resume them", () => {
		const f = fixture();
		expect(f.run(1, "A", ["--plan-only"]).status).toBe(0);
		const [meta] = f.metas();
		const planPath = join(f.plansDir, `${meta.planId}.json`);
		const plan = JSON.parse(readFileSync(planPath, "utf-8"));
		delete plan.launcherPinVersion;
		for (const key of ["launcherPath", "launcherRealPath", "launcherHash"]) {
			delete meta[key];
			delete plan.runs[0][key];
		}
		writeFileSync(planPath, JSON.stringify(plan));
		writeFileSync(join(meta.runDir, "meta.json"), JSON.stringify(meta));
		const result = f.resume(meta.planId);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no supported agent launcher pin");
		expect(f.hasEvents()).toBe(false);
		expect(f.analyze().stdout).toContain("Run inventory: 1/1 planned records match");
	});
});

describe("saved benchmark plans", () => {
	it("saves the whole plan without starting agents", () => {
		const f = fixture();
		const result = f.run(3, "A,B,F", ["--plan-only", "--variant", "split"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("9 run(s) saved without execution");
		expect(f.hasEvents()).toBe(false);
		expect(f.metas()).toHaveLength(9);
		for (const meta of f.metas()) {
			expect(meta).toMatchObject({ driverStatus: "planned", startedAt: null, checkPass: null });
			expect(readdirSync(meta.runDir).sort()).toEqual(["meta.json", "models.json", "task"]);
		}
		expect(readdirSync(f.locksDir)).toEqual([]);
		expect(f.analyze().stdout).toContain("Run inventory: 9/9 planned records match");
	});

	it("resumes original slots and snapshots without the source tasks or provider seed", () => {
		const f = fixture({ turns: ["first", "second"], check: 'test "$(cat "$PROJECT_DIR/input.txt")" = original' });
		mkdirSync(join(f.taskDir, "fixture"));
		writeFileSync(join(f.taskDir, "fixture/input.txt"), "original");
		expect(f.run(1, "A,B,F", ["--plan-only"]).status).toBe(0);
		const before = f.metas();
		const planId = before[0].planId;
		const manifest = readFileSync(join(f.plansDir, `${planId}.json`), "utf-8");
		rmSync(dirname(f.taskDir), { recursive: true });
		rmSync(f.configPath);
		const result = f.resume(planId);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(readFileSync(join(f.plansDir, `${planId}.json`), "utf-8")).toBe(manifest);
		expect(f.metas().map((meta) => [meta.runId, meta.plannedAt])).toEqual(
			before.map((meta) => [meta.runId, meta.plannedAt]),
		);
		for (const meta of f.metas())
			expect(meta).toMatchObject({ driverStatus: "completed", checkPass: true, turnExitCodes: [0, 0] });
		expect(f.analyze().stdout).toContain("Run inventory: 3/3 planned records match");
		expect(readdirSync(f.plansDir)).toEqual([`${planId}.json`]);
		expect(readdirSync(f.locksDir)).toEqual([]);
	});

	it("does not rerun completed tasks, including failed acceptance checks", () => {
		const f = fixture({ check: "exit 1" });
		expect(f.run().status).toBe(0);
		const [meta] = f.metas();
		const path = join(meta.runDir, "meta.json");
		const before = readFileSync(path, "utf-8");
		const events = f.events();
		const result = f.resume(meta.planId);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("completed (not retried)");
		expect(readFileSync(path, "utf-8")).toBe(before);
		expect(f.events()).toEqual(events);
	});

	it("continues unstarted slots after interruption without retrying the attempted run", () => {
		const f = fixture({
			check: 'if [ ! -f "$PROJECT_DIR/../../../interrupted" ]; then touch "$PROJECT_DIR/../../../interrupted"; kill -KILL "$PPID"; fi\nexit 0',
		});
		const interrupted = f.run(2, "A,F");
		expect(interrupted.signal).toBe("SIGKILL");
		const attempted = f.metas().find((meta) => meta.driverStatus === "running");
		const path = join(attempted.runDir, "meta.json");
		const before = readFileSync(path, "utf-8");
		expect(f.events().at(-1).event).toBe("stop");
		const locked = f.resume(attempted.planId);
		expect(locked.status).toBe(1);
		expect(locked.stderr).toContain("benchmark plan is locked");
		// This fixture's driver was killed and its only daemon stopped before checking.
		rmSync(join(f.locksDir, `${attempted.planId}.lock`));
		const resumed = f.resume(attempted.planId);
		expect(resumed.status, resumed.stderr).toBe(1);
		expect(resumed.stdout).toContain("running (not retried)");
		expect(readFileSync(path, "utf-8")).toBe(before);
		expect(f.metas().filter((meta) => meta.driverStatus === "completed")).toHaveLength(3);
		expect(f.events().filter((event) => event.event === "start")).toHaveLength(4);
		expect(f.analyze().stdout).toContain("driver runs incomplete — no verdict");
	});

	it("retains driver errors while executing later unstarted slots", () => {
		const f = fixture();
		expect(f.run(2, "A", ["--plan-only"]).status).toBe(0);
		const [meta] = f.metas();
		const path = join(meta.runDir, "meta.json");
		const before = JSON.stringify({ ...meta, driverStatus: "error", driverError: "prior failure" });
		writeFileSync(path, before);
		const result = f.resume(meta.planId);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stdout).toContain("error (not retried)");
		expect(readFileSync(path, "utf-8")).toBe(before);
		expect(f.events().filter((event) => event.event === "start")).toHaveLength(1);
		expect(f.metas().filter((entry) => entry.driverStatus === "completed")).toHaveLength(1);
	});

	it("rejects a concurrent executor while the original plan is active", () => {
		const f = fixture({ mode: "resume-while-running" });
		expect(f.run().status).toBe(0);
		const [meta] = f.metas();
		const result = JSON.parse(readFileSync(join(meta.runDir, "agent-dir/resume-attempt.json"), "utf-8"));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("benchmark plan is locked");
		expect(f.events().map((event) => event.event)).toEqual(["start", "turn", "stop"]);
		expect(readdirSync(f.locksDir)).toEqual([]);
	});

	it.each([
		"task snapshot",
		"provider snapshot",
		"metadata",
		"missing record",
		"duplicate slot",
		"version",
		"legacy plan",
		"path",
		"state",
	])("rejects invalid saved evidence before starting any run: %s", (problem) => {
		const f = fixture();
		expect(f.run(2, "A", ["--plan-only"]).status).toBe(0);
		const [first, meta] = f.metas();
		const firstPath = join(first.runDir, "meta.json");
		const metaPath = join(meta.runDir, "meta.json");
		const planPath = join(f.plansDir, `${meta.planId}.json`);
		if (problem === "task snapshot") writeFileSync(join(meta.runDir, "task/check.sh"), "exit 1");
		if (problem === "provider snapshot") writeFileSync(join(meta.runDir, "models.json"), '{"secret":"do-not-print"}');
		if (problem === "metadata") writeFileSync(metaPath, JSON.stringify({ ...meta, model: "different" }));
		if (problem === "path") writeFileSync(metaPath, JSON.stringify({ ...meta, runDir: f.taskDir }));
		if (problem === "state") writeFileSync(metaPath, JSON.stringify({ ...meta, driverStatus: "unknown" }));
		if (problem === "missing record") rmSync(metaPath);
		if (problem === "duplicate slot" || problem === "version" || problem === "legacy plan") {
			const plan = JSON.parse(readFileSync(planPath, "utf-8"));
			if (problem === "version") plan.version = 99;
			else if (problem === "legacy plan") delete plan.executionLockVersion;
			else plan.runs.push(plan.runs[0]);
			writeFileSync(planPath, JSON.stringify(plan));
		}
		const before = readFileSync(firstPath, "utf-8");
		const result = f.resume(meta.planId);
		expect(result.status).toBe(1);
		expect(result.stdout + result.stderr).not.toContain("do-not-print");
		expect(f.hasEvents()).toBe(false);
		expect(readFileSync(firstPath, "utf-8")).toBe(before);
		expect(readdirSync(f.locksDir)).toEqual([]);
	});

	it.each([
		"project",
		"agent-dir",
		"turn-0.log",
		"meta.json.tmp",
		"startedAt",
		"daemonPid",
		"turnExitCodes",
		"checkPass",
	])("does not replay a planned slot containing execution evidence: %s", (evidence) => {
		const f = fixture();
		expect(f.run(1, "A", ["--plan-only"]).status).toBe(0);
		const [meta] = f.metas();
		if (["project", "agent-dir", "turn-0.log", "meta.json.tmp"].includes(evidence))
			writeFileSync(join(meta.runDir, evidence), "preserve");
		else
			writeFileSync(
				join(meta.runDir, "meta.json"),
				JSON.stringify({ ...meta, [evidence]: evidence === "turnExitCodes" ? [0] : 1 }),
			);
		const result = f.resume(meta.planId);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("contains execution evidence");
		expect(f.hasEvents()).toBe(false);
	});

	it.each(["../escape", "..", "/absolute", "--missing"])("rejects invalid plan IDs: %s", (planId) => {
		const f = fixture();
		expect(f.resume(planId).status).toBe(1);
		expect(f.hasEvents()).toBe(false);
		expect(f.metas()).toEqual([]);
	});

	it.each([["--reps", "1"], ["--groups", "F"], ["--plan-only"], ["--resume-plan", "other"]])(
		"rejects selection overrides when resuming: %j",
		(...args) => {
			const f = fixture();
			expect(f.run(1, "A", ["--plan-only"]).status).toBe(0);
			const result = f.resume(f.metas()[0].planId, args);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("without run-selection options");
			expect(f.hasEvents()).toBe(false);
		},
	);
});
