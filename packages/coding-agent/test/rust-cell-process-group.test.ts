import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import { runProcess } from "../src/core/rust-cell/process.js";
import { ProcessResourceGroup } from "../src/core/rust-cell/process-group.js";
import { resourceLimitedCommand, systemdUserEnvironment } from "../src/core/rust-cell/process-limits.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { hasProcessLimits } from "./fixtures/process-limits.js";

it("validates tree limits independently and defaults off", () => {
	expect(SettingsManager.inMemory().getRustCellTreeProcessLimits()).toBeUndefined();
	for (const treeProcessLimits of [{ tasksMax: 0 }, { cpuQuotaPercent: 1.5 }, { memoryMaxMb: -1 }]) {
		expect(() =>
			SettingsManager.inMemory({ rustCell: { treeProcessLimits } }).getRustCellTreeProcessLimits(),
		).toThrow("treeProcessLimits");
	}
	expect(() =>
		SettingsManager.inMemory({ rustCell: { treeProcessLimits: { tasksMax: 32 } } }).getRustCellTreeProcessLimits(),
	).toThrow(process.platform === "linux" ? "cargoSandbox" : "requires Linux");
});

const available = hasProcessLimits();
describe.skipIf(!available)("shared process groups", () => {
	const groups: ProcessResourceGroup[] = [];
	let root: string | undefined;
	const group = (limits: ConstructorParameters<typeof ProcessResourceGroup>[0]) => {
		const result = new ProcessResourceGroup(limits);
		groups.push(result);
		return result;
	};
	const run = (processGroup: ProcessResourceGroup, script: string) =>
		runProcess("/bin/sh", ["-c", script], { cwd: tmpdir(), timeoutMs: 10_000, processGroup });
	afterEach(() => {
		for (const item of groups.splice(0)) item.dispose();
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("requires sandboxed Cargo for SDK groups", () => {
		const shared = group({ tasksMax: 64 });
		expect(() => new RustCellProvisioner({ cwd: "/unused", processGroup: shared })).toThrow("cargoSandbox");
	});

	it("retains a group's budget until its last owner releases it", async () => {
		const shared = group({ memoryMaxMb: 128, tasksMax: 64 });
		const release = shared.retain();
		const result = await run(shared, "cat /proc/self/cgroup");
		expect(result.exitCode, result.stderr).toBe(0);
		const path = dirname(`/sys/fs/cgroup${result.stdout.trim().slice(3)}`);
		shared.dispose();
		expect((await run(shared, "printf still-shared")).stdout).toBe("still-shared");
		expect(readFileSync(join(path, "memory.max"), "utf8").trim()).toBe(String(128 * 1024 * 1024));
		release();
		release();
		expect(existsSync(path)).toBe(false);
		expect(existsSync(`/run/user/${process.getuid!()}/systemd/user.control/${shared.unit}.d`)).toBe(false);
		await expect(run(shared, "echo must-not-run")).rejects.toThrow("disposed");
	});

	it("fails closed if a shared control changes or the scope joins a different slice", async () => {
		const shared = group({ memoryMaxMb: 128 });
		const command = resourceLimitedCommand(
			{ bin: "/bin/echo", args: ["must-not-run"], env: process.env },
			undefined,
			shared,
		);
		execFileSync("/usr/bin/systemctl", ["--user", "set-property", "--runtime", shared.unit, "MemoryMax=256M"], {
			env: systemdUserEnvironment(),
		});
		const altered = await runProcess(command.bin, command.args, {
			cwd: tmpdir(),
			env: command.env,
			timeoutMs: 10_000,
		});
		expect(altered).toMatchObject({ exitCode: 125, stdout: "" });
		expect(altered.stderr).toContain("../memory.max is not enforced");
		const next = resourceLimitedCommand(
			{ bin: "/bin/echo", args: ["must-not-run"], env: process.env },
			undefined,
			shared,
		);
		const wrongSlice = await runProcess(
			command.bin,
			next.args.filter((arg) => !arg.startsWith("--slice=")),
			{ cwd: tmpdir(), env: command.env, timeoutMs: 10_000 },
		);
		expect(wrongSlice).toMatchObject({ exitCode: 125, stdout: "" });
		expect(wrongSlice.stderr).toContain("agent tree slice");
	});

	it("limits the sum of concurrent scopes without sharing unrelated trees' budgets", async () => {
		root = mkdtempSync(join(tmpdir(), "process-tree-memory-"));
		const source = join(root, "memory.c");
		const binary = join(root, "memory");
		writeFileSync(
			source,
			`#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
  volatile char *data = malloc(80 * 1024 * 1024);
  if (!data) return 2;
  for (size_t i=0; i<80 * 1024 * 1024; i+=4096) data[i]=42;
  puts("ready"); fflush(stdout);
  sleep(2); puts("finished"); return 0;
}`,
		);
		execFileSync("cc", ["-O2", source, "-o", binary]);
		const pair = async (first: ProcessResourceGroup, second: ProcessResourceGroup) => {
			let ready!: () => void;
			const allocated = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const options = { cwd: root!, timeoutMs: 10_000, processLimits: { memoryMaxMb: 128 } };
			const a = runProcess(binary, [], {
				...options,
				processGroup: first,
				onChunk: (text) => {
					if (text.includes("ready")) ready();
				},
			});
			await Promise.race([
				allocated,
				a.then((result) => {
					throw new Error(`First allocation failed: ${JSON.stringify(result)}`);
				}),
			]);
			return Promise.all([a, runProcess(binary, [], { ...options, processGroup: second })]);
		};
		const independent = await pair(group({ memoryMaxMb: 128 }), group({ memoryMaxMb: 128 }));
		expect(independent.map((r) => r.exitCode)).toEqual([0, 0]);
		const shared = group({ memoryMaxMb: 128 });
		const limited = await pair(shared, shared);
		expect(
			limited.some((r) => r.exitCode !== 0),
			JSON.stringify(limited),
		).toBe(true);
		expect(limited.every((r) => !r.timedOut)).toBe(true);
	}, 30_000);

	it("aborting one scope leaves a sibling's work running", async () => {
		const shared = group({ tasksMax: 64 });
		const abort = new AbortController();
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const pending = runProcess("/bin/sh", ["-c", "printf ready; exec sleep 30"], {
			cwd: tmpdir(),
			timeoutMs: 10_000,
			signal: abort.signal,
			processGroup: shared,
			onChunk: (text) => {
				if (text.includes("ready")) ready();
			},
		});
		try {
			await Promise.race([
				started,
				pending.then((result) => {
					throw new Error(JSON.stringify(result));
				}),
			]);
			const sibling = runProcess("/bin/sh", ["-c", "printf ready; sleep 0.2; printf survived"], {
				cwd: tmpdir(),
				timeoutMs: 10_000,
				processGroup: shared,
				onChunk: () => abort.abort(),
			});
			expect(await sibling).toMatchObject({ exitCode: 0, stdout: "readysurvived" });
			expect(await pending).toMatchObject({ aborted: true });
		} finally {
			abort.abort();
			await pending;
		}
	});

	it("bounds process creation across sibling scopes", async () => {
		root = mkdtempSync(join(tmpdir(), "process-tree-tasks-"));
		const source = join(root, "tasks.c");
		const binary = join(root, "tasks");
		writeFileSync(
			source,
			`#include <stdlib.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
int main(int argc, char **argv) {
  int count=atoi(argv[1]), n=0, denied=0; pid_t children[32];
  for (;n<count;n++) { pid_t p=fork(); if(p<0) { denied=(errno==EAGAIN); break; } if(!p) { pause(); _exit(0); } children[n]=p; }
  printf("ready children=%d denied=%d\\n",n,denied); fflush(stdout); sleep(2);
  for(int i=0;i<n;i++) kill(children[i],SIGKILL);
  for(int i=0;i<n;i++) waitpid(children[i],NULL,0);
  return 0;
}`,
		);
		execFileSync("cc", ["-O2", source, "-o", binary]);
		const shared = group({ tasksMax: 16 });
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const options = { cwd: root, timeoutMs: 10_000, processGroup: shared, processLimits: { tasksMax: 32 } };
		const first = runProcess(binary, ["8"], {
			...options,
			onChunk: (text) => {
				if (text.includes("ready")) ready();
			},
		});
		await Promise.race([
			started,
			first.then((result) => {
				throw new Error(JSON.stringify(result));
			}),
		]);
		const second = await runProcess(binary, ["16"], options);
		expect(await first).toMatchObject({ exitCode: 0, stdout: "ready children=8 denied=0\n" });
		expect(second.exitCode, second.stderr).toBe(0);
		expect(second.stdout).toContain("denied=1");
	}, 20_000);

	it("throttles concurrent scopes against the shared CPU budget", async () => {
		const shared = group({ cpuQuotaPercent: 10 });
		const script = `const fs=require('node:fs'); const path=require('node:path');
const start=process.cpuUsage(); while(process.cpuUsage(start).user<100000) {}
const cg=fs.readFileSync('/proc/self/cgroup','utf8').trim().slice(3);
console.log(fs.readFileSync(path.dirname('/sys/fs/cgroup'+cg)+'/cpu.stat','utf8'));`;
		const started = performance.now();
		const results = await Promise.all(
			[1, 2].map(() =>
				runProcess(process.execPath, ["-e", script], { cwd: tmpdir(), timeoutMs: 15_000, processGroup: shared }),
			),
		);
		for (const result of results) {
			expect(result.exitCode, result.stderr).toBe(0);
			expect(Number(/nr_throttled (\d+)/.exec(result.stdout)?.[1])).toBeGreaterThan(0);
		}
		expect(performance.now() - started).toBeGreaterThan(1500);
	}, 20_000);
});
