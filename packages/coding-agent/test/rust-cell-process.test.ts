import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { runProcess } from "../src/core/rust-cell/process.js";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	spawn: vi.fn(),
}));

const children: (EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough })[] = [];
const pending: Promise<unknown>[] = [];
const workspaces: string[] = [];

function childFixture() {
	const child = Object.assign(new EventEmitter(), {
		pid: 12345 as number | undefined,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => true),
	});
	children.push(child);
	vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
	vi.spyOn(process, "kill").mockReturnValue(true);
	return child;
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.emit("close", null);
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
	}
	await Promise.allSettled(pending.splice(0));
	vi.restoreAllMocks();
	vi.mocked(childProcess.spawn).mockReset();
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("cell process error cleanup", () => {
	it.each(["bridge attachment", "child error"])("waits for close after %s fails", async (kind) => {
		const child = childFixture();
		const failure = new Error("process setup failed");
		const controller = new AbortController();
		const run = runProcess("runtime", [], {
			cwd: process.cwd(),
			timeoutMs: 10_000,
			signal: controller.signal,
			bridge: {
				token: "token",
				attach: () => {
					if (kind === "bridge attachment") throw failure;
				},
			},
		});
		pending.push(run);
		let settled = false;
		const outcome = run.catch((error: unknown) => {
			settled = true;
			return error;
		});
		if (kind === "child error") child.emit("error", failure);
		await Promise.resolve();
		expect(process.kill).toHaveBeenCalledWith(-child.pid!, "SIGKILL");
		expect(settled).toBe(false);
		child.emit("exit", null, "SIGKILL");
		await Promise.resolve();
		expect(settled).toBe(false);
		child.emit("error", new Error("later error"));
		child.emit("close", null, "SIGKILL");
		expect(await outcome).toBe(failure);
		const kills = vi.mocked(process.kill).mock.calls.length;
		controller.abort();
		expect(process.kill).toHaveBeenCalledTimes(kills);
	});

	it("waits for a failed spawn to close without trying to kill a missing pid", async () => {
		const child = childFixture();
		child.pid = undefined;
		const failure = new Error("spawn ENOENT");
		const run = runProcess("missing", [], { cwd: process.cwd(), timeoutMs: 10_000 });
		pending.push(run);
		let settled = false;
		const outcome = run.catch((error: unknown) => {
			settled = true;
			return error;
		});
		child.emit("error", failure);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(process.kill).not.toHaveBeenCalled();
		child.emit("close", -2);
		expect(await outcome).toBe(failure);
	});

	it("preserves an undefined bridge attachment error after draining", async () => {
		const child = childFixture();
		const run = runProcess("runtime", [], {
			cwd: process.cwd(),
			timeoutMs: 10_000,
			bridge: {
				token: "token",
				attach: () => {
					throw undefined;
				},
			},
		});
		pending.push(run);
		const outcome = run.then(
			() => "resolved",
			(error: unknown) => error,
		);
		child.emit("close", 0);
		expect(await outcome).toBeUndefined();
	});

	it("rejects a synchronous spawn failure without waiting for a child", async () => {
		const failure = new Error("invalid spawn options");
		vi.mocked(childProcess.spawn).mockImplementation(() => {
			throw failure;
		});
		await expect(runProcess("runtime", [], { cwd: process.cwd(), timeoutMs: 10_000 })).rejects.toBe(failure);
	});

	it("retains the attachment error if killing the child also emits an error", async () => {
		const child = childFixture();
		const failure = new Error("attachment failed");
		vi.mocked(process.kill).mockImplementation(() => {
			throw new Error("group kill failed");
		});
		child.kill.mockImplementation(() => {
			child.emit("error", new Error("child kill failed"));
			return false;
		});
		const run = runProcess("runtime", [], {
			cwd: process.cwd(),
			timeoutMs: 10_000,
			bridge: {
				token: "token",
				attach: () => {
					throw failure;
				},
			},
		});
		pending.push(run);
		const outcome = run.catch((error: unknown) => error);
		expect(child.kill).toHaveBeenCalledTimes(1);
		child.emit("close", null);
		expect(await outcome).toBe(failure);
	});

	it("holds source rollback and the next cell until the failed compiler closes", async () => {
		const child = childFixture();
		const workspace = mkdtempSync(join(tmpdir(), "cell-process-drain-"));
		workspaces.push(workspace);
		mkdirSync(join(workspace, "cell/src"), { recursive: true });
		mkdirSync(join(workspace, "agent_lib/src"), { recursive: true });
		const main = join(workspace, "cell/src/main.rs");
		const lib = join(workspace, "agent_lib/src/lib.rs");
		writeFileSync(main, "previous cell");
		writeFileSync(lib, "previous library");
		const runner = new CellRunner({
			cwd: workspace,
			workspaceDir: workspace,
			cargoBin: "cargo",
			wasmedgeBin: "wasmedge",
			cellTimeoutMs: 10_000,
		});
		const failure = new Error("compiler failed");
		const nextFailure = new Error("next compiler could not spawn");
		vi.mocked(childProcess.spawn)
			.mockReturnValueOnce(child as unknown as childProcess.ChildProcess)
			.mockImplementation(() => {
				throw nextFailure;
			});
		const active = runner.execute({ code: "active cell", lib: [{ path: "src/lib.rs", content: "active library" }] });
		const queued = runner.execute({ code: "queued cell" });
		pending.push(active, queued);
		const outcome = active.catch((error: unknown) => error);
		const nextOutcome = queued.catch((error: unknown) => error);
		await vi.waitFor(() => expect(childProcess.spawn).toHaveBeenCalledTimes(1));
		child.emit("error", failure);
		await setImmediate();
		expect(childProcess.spawn).toHaveBeenCalledTimes(1);
		expect(readFileSync(main, "utf8")).toBe("active cell");
		expect(readFileSync(lib, "utf8")).toBe("active library");
		child.emit("close", null);
		expect(await outcome).toBe(failure);
		expect(await nextOutcome).toBe(nextFailure);
		expect(readFileSync(main, "utf8")).toBe("previous cell");
		expect(readFileSync(lib, "utf8")).toBe("previous library");
	});
});
