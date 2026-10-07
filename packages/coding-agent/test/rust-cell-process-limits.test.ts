import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import { runProcess } from "../src/core/rust-cell/process.js";
import {
	normalizeProcessLimits,
	type ProcessLimits,
	resourceLimitedCommand,
} from "../src/core/rust-cell/process-limits.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createRustTool } from "../src/core/tools/rust.js";
import { hasProcessLimits } from "./fixtures/process-limits.js";

describe("process limit configuration", () => {
	it("defaults off and freezes a validated copy", () => {
		for (const input of [undefined, null, {}, { memoryMaxMb: null }])
			expect(normalizeProcessLimits(input)).toBeUndefined();
		const input = { memoryMaxMb: 128, cpuQuotaPercent: 25, tasksMax: 32 };
		const limits = normalizeProcessLimits(input, "linux");
		input.memoryMaxMb = 256;
		expect(limits).toEqual({ memoryMaxMb: 128, cpuQuotaPercent: 25, tasksMax: 32 });
		expect(Object.isFrozen(limits)).toBe(true);
		expect(() => normalizeProcessLimits(limits, "darwin")).toThrow("requires Linux");
		const command = { bin: "/unused", args: [], env: {} };
		expect(resourceLimitedCommand(command)).toBe(command);
	});
	it("rejects invalid settings and SDK options before provisioning", () => {
		for (const invalid of [
			true,
			1,
			[],
			"auto",
			{ rss: 32 },
			{ memoryMaxMb: 0 },
			{ cpuQuotaPercent: 1.5 },
			{ tasksMax: 4_194_305 },
		]) {
			const processLimits = invalid as ProcessLimits;
			expect(() => new RustCellProvisioner({ cwd: "/unused", cargoSandbox: "bubblewrap", processLimits })).toThrow();
			expect(() => createRustTool("/unused", { processLimits })).toThrow("processLimits");
			expect(() => SettingsManager.inMemory({ rustCell: { processLimits } }).getRustCellResourceLimits()).toThrow(
				"processLimits",
			);
		}
	});
	it("requires compilation isolation with enabled runtime limits", () => {
		expect(() => new RustCellProvisioner({ cwd: "/unused", processLimits: { memoryMaxMb: 128 } })).toThrow(
			process.platform === "linux" ? "cargoSandbox" : "requires Linux",
		);
	});
});

const available = hasProcessLimits();

describe.skipIf(!available)("real cgroup v2 process limits", () => {
	let root: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "process-limits-test-"));
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("preserves argument bytes, cwd, output and exit status", async () => {
		const literal = `\${HOME} $$ spaces; "quotes"`;
		const result = await runProcess(
			"/bin/sh",
			["-c", 'printf "%s\\n%s" "$1" "$PWD"; printf err >&2; exit 7', "test", literal],
			{
				cwd: root,
				timeoutMs: 10_000,
				processLimits: { memoryMaxMb: 128, tasksMax: 32 },
			},
		);
		expect(result).toMatchObject({ exitCode: 7, stdout: `${literal}\n${root}`, stderr: "err", timedOut: false });
	});

	it("refuses to execute when a requested kernel control is absent", async () => {
		const command = resourceLimitedCommand(
			{ bin: "/bin/echo", args: ["must-not-run"], env: process.env },
			{ memoryMaxMb: 128 },
		);
		command.args = command.args.filter((arg) => !arg.startsWith("--property=MemoryMax="));
		const result = await runProcess(command.bin, command.args, { cwd: root, env: command.env, timeoutMs: 10_000 });
		expect(result.exitCode).toBe(125);
		expect(result.stdout).not.toContain("must-not-run");
		expect(result.stderr).toContain("memory.max is not enforced");
	});

	it("enforces aggregate memory across detached descendants", async () => {
		const source = join(root, "memory.c");
		const binary = join(root, "memory");
		writeFileSync(
			source,
			`#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
int main(void) {
  int ready[2]; if (pipe(ready)) return 1;
  pid_t child = fork(); if (child < 0) return 2;
  if (!child) setsid();
  volatile char *data = malloc(80 * 1024 * 1024);
  if (!data) return 3;
  for (size_t i = 0; i < 80 * 1024 * 1024; i += 4096) data[i] = 42;
  if (!child) { write(ready[1], "x", 1); sleep(1); return 0; }
  char c; if (read(ready[0], &c, 1) != 1) return 4;
  int status; waitpid(child, &status, 0);
  puts("allocated"); return WIFEXITED(status) ? WEXITSTATUS(status) : 5;
}`,
		);
		execFileSync("cc", ["-O2", source, "-o", binary]);
		const run = (memoryMaxMb: number) =>
			runProcess(binary, [], { cwd: root, timeoutMs: 10_000, processLimits: { memoryMaxMb } });
		const ok = await run(256);
		expect(ok.exitCode, ok.stderr).toBe(0);
		const denied = await run(128);
		expect(denied.exitCode).not.toBe(0);
		expect(denied.timedOut).toBe(false);
		expect(denied.stdout).not.toContain("allocated");
	}, 30_000);

	it("throttles CPU bandwidth", async () => {
		const script = `const fs = require("node:fs");
const started = process.cpuUsage();
while (process.cpuUsage(started).user < 150000) {}
const group = fs.readFileSync("/proc/self/cgroup", "utf8").trim().slice(3);
console.log(fs.readFileSync("/sys/fs/cgroup" + group + "/cpu.stat", "utf8"));`;
		const started = performance.now();
		const result = await runProcess(process.execPath, ["-e", script], {
			cwd: root,
			timeoutMs: 15_000,
			processLimits: { cpuQuotaPercent: 10 },
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(Number(/nr_throttled (\d+)/.exec(result.stdout)?.[1])).toBeGreaterThan(0);
		expect(performance.now() - started).toBeGreaterThan(800);
	}, 20_000);

	it("bounds process creation", async () => {
		const source = join(root, "tasks.c");
		const binary = join(root, "tasks");
		writeFileSync(
			source,
			`#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
int main(void) {
  pid_t children[32]; int n=0, denied=0;
  for (; n<32; n++) { pid_t pid=fork(); if (pid<0) { denied=(errno==EAGAIN); break; } if (!pid) { pause(); _exit(0); } children[n]=pid; }
  for (int i=0; i<n; i++) kill(children[i], SIGKILL);
  for (int i=0; i<n; i++) waitpid(children[i], NULL, 0);
  printf("children=%d\\n", n); return denied ? 0 : 1;
}`,
		);
		execFileSync("cc", ["-O2", source, "-o", binary]);
		const result = await runProcess(binary, [], { cwd: root, timeoutMs: 10_000, processLimits: { tasksMax: 8 } });
		expect(result.exitCode, result.stderr).toBe(0);
		const count = Number(/children=(\d+)/.exec(result.stdout)?.[1]);
		expect(count).toBeGreaterThan(0);
		expect(count).toBeLessThan(8);
	});

	it.each(["abort", "timeout"])("retains %s behavior and releases the scope", async (kind) => {
		const controller = new AbortController();
		let group = "";
		const result = await runProcess("/bin/sh", ["-c", "cat /proc/self/cgroup; exec sleep 60"], {
			cwd: root,
			timeoutMs: kind === "timeout" ? 1000 : 10_000,
			signal: controller.signal,
			processLimits: { memoryMaxMb: 128 },
			onChunk: (text, stream) => {
				if (stream === "stdout") {
					group += text;
					if (group.includes(".scope") && kind === "abort") controller.abort();
				}
			},
		});
		expect(result[kind === "abort" ? "aborted" : "timedOut"]).toBe(true);
		expect(group).toContain(".scope");
		const path = `/sys/fs/cgroup${group.trim().slice(3)}`;
		for (let i = 0; i < 20 && existsSync(path); i++) await delay(50);
		expect(existsSync(path)).toBe(false);
	});
});
