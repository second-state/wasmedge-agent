import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
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
	for (const name of ["run.ts", "analyze.ts"]) copyFileSync(join(repo, "poc/bench", name), join(bench, name));
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
const mode = ${JSON.stringify(mode)};
const agentDir = process.env.WASMEDGE_AGENT_CODING_AGENT_DIR;
const marker = ${JSON.stringify(join(root, "first-attempt"))};
const events = ${JSON.stringify(join(root, "daemon-events.jsonl"))};
const socketPath = process.argv[process.argv.indexOf("--daemon-socket") + 1];
const record = (event) => appendFileSync(events, JSON.stringify({ event, socketPath, pid: process.pid }) + "\\n");
if (process.argv.includes("daemon")) {
  record("start");
  if (mode === "observe-plan") {
    const runs = join(agentDir, "../..");
    writeFileSync(${JSON.stringify(join(root, "plan-at-start.json"))}, JSON.stringify(readdirSync(runs).map((id) => JSON.parse(readFileSync(join(runs, id, "meta.json"), "utf-8")))));
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
		temp,
		addTask(id: string, spec?: unknown) {
			const dir = join(bench, "tasks", id);
			mkdirSync(dir);
			writeFileSync(join(dir, "task.json"), JSON.stringify(spec ?? { category: "fixture", turns, timeoutMs }));
			copyFileSync(join(task, "check.sh"), join(dir, "check.sh"));
		},
		planAtStart() {
			return JSON.parse(readFileSync(join(root, "plan-at-start.json"), "utf-8"));
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
	it("registers the full matrix before launch and retains unstarted runs after interruption", () => {
		const f = fixture({ mode: "observe-plan", check: 'kill -KILL "$PPID"' });
		f.addTask("second");
		const result = f.run(3, "A,B,F", ["--models", "provider-one/shared,provider-two/shared", "--variant", "split"]);
		expect(result.signal).toBe("SIGKILL");
		const before = f.planAtStart();
		const metas = f.metas();
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
		expect(csv.split("\n").filter((line) => line.endsWith(",planned"))).toHaveLength(35);
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
