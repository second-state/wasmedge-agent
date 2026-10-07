import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBuildConcurrency, withBuildPermit } from "../src/core/rust-cell/build-gate.js";
import { CellRunner, composeToolText } from "../src/core/rust-cell/cell-runner.js";
import { WorkspaceHistory } from "../src/core/rust-cell/workspace-history.js";

interface Invocation {
	phase: "build" | "probe" | "run";
	args: string[];
}

interface Behavior {
	buildExit?: number;
	buildDelay?: number;
	probeExit?: number;
	probeDelay?: number;
	probeBindFailure?: "stdout" | "stderr";
	runExit?: number;
}

// Actual subprocesses let abort/timeout tests exercise process termination.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const behavior = JSON.parse(fs.readFileSync("behavior.json", "utf8"));
const args = process.argv.slice(2);
const phase = path.basename(process.argv[1]) === "cargo" ? "build"
    : args.at(-1).endsWith("cell.wasm") ? "run" : "probe";
if (phase === "probe") {
    const module = new WebAssembly.Module(fs.readFileSync(args.at(-1)));
    if (WebAssembly.Module.imports(module).length !== 0) process.exit(99);
    new WebAssembly.Instance(module).exports._start();
}
fs.appendFileSync("invocations.jsonl", JSON.stringify({phase, args}) + "\\n");
if (phase === "probe" && behavior.probeBindFailure) {
    process[behavior.probeBindFailure].write("Bind guest directory failed:No such file or directory.\\n");
}
setTimeout(() => process.exit(behavior[phase + "Exit"] ?? 0), behavior[phase + "Delay"] ?? 0);
`;

describe.skipIf(process.platform === "win32")("cell execution boundaries", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function fixture(cellTimeoutMs = 20_000, persist = false) {
		const ws = mkdtempSync(join(tmpdir(), "cell-execution-"));
		dirs.push(ws);
		mkdirSync(join(ws, "agent_lib", "src", "helpers"), { recursive: true });
		mkdirSync(join(ws, "cell", "src"), { recursive: true });
		const main = join(ws, "cell", "src", "main.rs");
		const mod = join(ws, "agent_lib", "src", "helpers", "mod.rs");
		writeFileSync(main, "original main");
		writeFileSync(mod, "original helpers");
		const target = join(ws, "target/wasm32-wasip1/release");
		mkdirSync(target, { recursive: true });
		writeFileSync(
			join(target, "cell.wasm"),
			Buffer.from("0061736d0100000001040160000003020100070a01065f737461727400000a040102000b", "hex"),
		);
		const cargoBin = join(ws, "cargo");
		const wasmedgeBin = join(ws, "wasmedge");
		writeFileSync(cargoBin, STUB, { mode: 0o755 });
		writeFileSync(wasmedgeBin, STUB, { mode: 0o755 });
		const behavior = (value: Behavior) => writeFileSync(join(ws, "behavior.json"), JSON.stringify(value));
		behavior({});
		const invocations = (): Invocation[] => {
			const file = join(ws, "invocations.jsonl");
			return existsSync(file)
				? readFileSync(file, "utf-8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as Invocation)
				: [];
		};
		const history = persist ? new WorkspaceHistory(ws) : undefined;
		history?.ensure();
		const runner = new CellRunner({ cwd: ws, workspaceDir: ws, cargoBin, wasmedgeBin, cellTimeoutMs, history });
		return { ws, main, mod, behavior, invocations, runner };
	}

	it("probes with an inert module and executes each submitted cell only once", async () => {
		const f = fixture();
		expect((await f.runner.execute({ code: "first cell" })).status).toBe("ok");
		expect((await f.runner.execute({ code: "second cell" })).status).toBe("ok");
		const calls = f.invocations();
		expect(calls.map((call) => call.phase)).toEqual(["build", "probe", "run", "build", "run"]);
		for (const call of calls.filter((call) => call.phase === "run"))
			expect(call.args).toContain("--force-interpreter");
		const probe = calls[1];
		expect(probe.args).toContain(`/agent/lib:${join(f.ws, "agent_lib")}:readonly`);
		expect(existsSync(probe.args.at(-1)!)).toBe(false);
	});

	it("rejects uninspectable artifacts before probing or executing", async () => {
		const f = fixture();
		writeFileSync(join(f.ws, "target/wasm32-wasip1/release/cell.wasm"), "invalid Wasm");
		const result = await f.runner.execute({ code: "built source" });
		expect(result.status).toBe("error");
		expect(result.stderr).toContain("cannot inspect cell module");
		expect(f.invocations().map((call) => call.phase)).toEqual(["build"]);
	});

	it("snapshots successful cells only and reports a commit failure without repeating execution", async () => {
		const f = fixture(20_000, true);
		const count = () =>
			execFileSync("git", ["-C", f.ws, "rev-list", "--count", "HEAD"], { encoding: "utf-8" }).trim();
		const success = await f.runner.execute({ code: "first" }, { cellId: "tool-first" });
		expect(success.workspaceCommit).toMatch(/^[0-9a-f]{40,64}$/);
		expect(count()).toBe("2");
		f.behavior({ runExit: 1 });
		expect((await f.runner.execute({ code: "panics" })).status).toBe("error");
		expect(count()).toBe("2");
		f.behavior({ buildExit: 1 });
		expect((await f.runner.execute({ code: "broken" })).status).toBe("compile_error");
		expect(count()).toBe("2");
		f.behavior({});
		writeFileSync(join(f.ws, ".git", "index.lock"), "locked");
		const uncommitted = await f.runner.execute({ code: "last" });
		expect(uncommitted.status).toBe("ok");
		expect(uncommitted.workspaceCommit).toBeUndefined();
		expect(uncommitted.workspaceCommitError).toContain("index.lock");
		expect(composeToolText(uncommitted)).toContain("cell succeeded, but its workspace snapshot failed");
		expect(count()).toBe("2");
		expect(f.invocations().filter((call) => call.phase === "run")).toHaveLength(3);
	});

	it.each(["stdout", "stderr"] as const)("drops a failed readonly mount reported on %s", async (stream) => {
		const f = fixture();
		f.behavior({ probeBindFailure: stream });
		expect(await f.runner.execute({ code: "cell" })).toMatchObject({ status: "ok", libReadonlyFallback: true });
		const calls = f.invocations();
		expect(calls.map((call) => call.phase)).toEqual(["build", "probe", "run"]);
		expect(calls[2].args.some((arg) => arg.startsWith("/agent/lib:"))).toBe(false);
	});

	it.each(["abort", "timeout", "error"])("does not execute or cache an interrupted probe: %s", async (kind) => {
		const f = fixture(kind === "timeout" ? 5_000 : 20_000);
		f.behavior(kind === "error" ? { probeExit: 1 } : { probeDelay: 60_000 });
		const controller = new AbortController();
		const pending = f.runner.execute({ code: "cell" }, { signal: controller.signal });
		await vi.waitFor(() => expect(f.invocations().some((call) => call.phase === "probe")).toBe(true), {
			timeout: 5_000,
		});
		if (kind === "abort") controller.abort();
		expect((await pending).status).toBe(kind === "abort" ? "aborted" : kind);
		expect(f.invocations().map((call) => call.phase)).toEqual(["build", "probe"]);
		expect(existsSync(f.invocations()[1].args.at(-1)!)).toBe(false);
		f.behavior({});
		expect((await f.runner.execute({ code: "retry" })).status).toBe("ok");
		expect(f.invocations().map((call) => call.phase)).toEqual(["build", "probe", "build", "probe", "run"]);
	});

	it.each(["abort", "timeout"])("restores sources when the build is interrupted: %s", async (kind) => {
		const f = fixture(kind === "timeout" ? 5_000 : 20_000);
		f.behavior({ buildDelay: 60_000 });
		const controller = new AbortController();
		const pending = f.runner.execute(
			{ code: "new cell", lib: [{ path: "src/helpers/new.rs", content: "new helper" }] },
			{ signal: controller.signal },
		);
		await vi.waitFor(() => expect(f.invocations().length).toBe(1), { timeout: 5_000 });
		if (kind === "abort") controller.abort();
		expect(await pending).toMatchObject({ status: kind === "abort" ? "aborted" : "timeout", libReverted: true });
		expect(readFileSync(f.main, "utf-8")).toBe("original main");
		expect(readFileSync(f.mod, "utf-8")).toBe("original helpers");
		expect(existsSync(join(f.ws, "agent_lib", "src", "helpers", "new.rs"))).toBe(false);
		expect(f.invocations().map((call) => call.phase)).toEqual(["build"]);
	});

	it("expires while waiting for the build gate without starting cargo", async () => {
		const f = fixture(100);
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let admitted = 0;
		const permits = resolveBuildConcurrency();
		const holders = Array.from({ length: permits }, () =>
			withBuildPermit(async () => {
				admitted++;
				await held;
			}),
		);
		try {
			await vi.waitFor(() => expect(admitted).toBe(permits));
			const timed = await f.runner.execute({ code: "queued cell" });
			expect(timed.status).toBe("timeout");
			expect(timed.timings!.buildQueueMs).toBeGreaterThan(0);
			expect(timed.timings).toMatchObject({ cargoMs: 0, executionMs: 0 });
			expect(f.invocations()).toEqual([]);
			expect(readFileSync(f.main, "utf-8")).toBe("original main");
		} finally {
			release();
			await Promise.all(holders);
		}
	});

	it("retains compiled source changes after a runtime error", async () => {
		const f = fixture();
		f.behavior({ runExit: 1 });
		expect(
			await f.runner.execute({ code: "new cell", lib: [{ path: "src/helpers/new.rs", content: "new helper" }] }),
		).toMatchObject({ status: "error", libReverted: false });
		expect(readFileSync(f.main, "utf-8")).toBe("new cell");
		expect(readFileSync(join(f.ws, "agent_lib", "src", "helpers", "new.rs"), "utf-8")).toBe("new helper");
	});
});
