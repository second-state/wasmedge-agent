import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cellProcess from "../src/core/rust-cell/process.js";
import { WorkspaceHistory } from "../src/core/rust-cell/workspace-history.js";
import { isProcessAlive } from "../src/utils/child-process.js";

describe("session workspace history", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "cell-history-"));
		dirs.push(root);
		const ws = join(root, "workspace");
		function write(path: string, contents: string) {
			mkdirSync(dirname(join(ws, path)), { recursive: true });
			writeFileSync(join(ws, path), contents);
		}
		write("cell/src/main.rs", "fn main() {}\n");
		const git = (...args: string[]) => execFileSync("git", ["-C", ws, ...args], { encoding: "utf-8" }).trim();
		return { root, ws, write, git, history: new WorkspaceHistory(ws) };
	}

	it("records source and state, including deletions, and resumes cell numbering", async () => {
		const { ws, write, git, history } = fixture();
		await history.ensure();
		write("cell/src/main.rs", 'fn main() { println!("one"); }\n');
		write("agent_lib/src/helpers/one.rs", "pub fn one() {}\n");
		write("state/state.json", '{"counter":1}');
		write("state/blobs/data.bin", "blob");
		for (const path of ["target/cell.wasm", "vendor/crate/lib.rs", ".scratch/tmp", "unrelated.txt"])
			write(path, "omit");
		const first = await history.snapshot("tool-call-1");
		expect(git("show", `${first}:state/state.json`)).toBe('{"counter":1}');
		expect(git("show", `${first}:state/blobs/data.bin`)).toBe("blob");
		expect(git("log", "-1", "--format=%B")).toContain('Tool-Call-ID: "tool-call-1"');
		expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/target|vendor|scratch|unrelated/);
		rmSync(join(ws, "agent_lib/src/helpers/one.rs"));
		const resumed = new WorkspaceHistory(ws);
		await resumed.ensure();
		await resumed.snapshot("tool-call-2");
		expect(git("log", "-1", "--format=%s")).toBe("chore(cell): snapshot cell 2");
		expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("one.rs");
		await resumed.snapshot("tool-call-3");
		expect(git("rev-list", "--count", "HEAD")).toBe("4");
	});

	it("leaves unrelated staged files out of a snapshot", async () => {
		const { write, git, history } = fixture();
		await history.ensure();
		write("private.txt", "not a workspace artifact");
		git("add", "private.txt");
		await history.snapshot("tool-1");
		expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("private.txt");
		expect(git("diff", "--cached", "--name-only")).toBe("private.txt");
	});

	it.each(["initial", "cell", "dependency"])("waits for automatic maintenance during %s snapshots", async (kind) => {
		const { root, ws, write, git, history } = fixture();
		git("init", "--quiet", "--template=");
		git("config", "maintenance.autoDetach", "true");
		git("config", "gc.autoDetach", "true");
		git("config", "maintenance.gc.enabled", "false");
		git("config", "maintenance.commit-graph.enabled", "true");
		git("config", "maintenance.commit-graph.auto", "-1");
		const trace = join(root, "git-trace.jsonl");
		const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
		const bin = join(root, "bin");
		mkdirSync(bin);
		// Observe real Git's child processes after the runtime strips inherited GIT_* variables.
		writeFileSync(
			join(bin, "git"),
			`#!${process.execPath}
const { spawnSync } = require("node:child_process");
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, GIT_TRACE2_EVENT: ${JSON.stringify(trace)} },
});
process.exit(result.status ?? 1);
`,
			{ mode: 0o755 },
		);
		vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
		await history.ensure();
		if (kind !== "initial") {
			writeFileSync(trace, "");
			write("state/state.json", '{"counter":1}');
			if (kind === "cell") await history.snapshot("maintenance-cell");
			else await history.snapshotDependency("itoa");
		}
		const events = readFileSync(trace, "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { event: string; argv?: string[] });
		const maintenance = events.filter(
			(event) => event.event === "child_start" && event.argv?.includes("maintenance"),
		);
		expect(maintenance).toHaveLength(1);
		expect(maintenance[0].argv).not.toContain("--detach");
		expect(existsSync(join(ws, ".git", "objects", "maintenance.lock"))).toBe(false);
		expect(existsSync(join(ws, ".git", "objects", "info", "commit-graphs", "commit-graph-chain"))).toBe(true);
		expect(git("commit-graph", "verify")).toBe("");
		expect(git("fsck", "--no-dangling")).toBe("");
	});

	it("ignores inherited Git destinations and hooks without touching the enclosing project", async () => {
		const { root, ws, git, history } = fixture();
		execFileSync("git", ["init", "--quiet", root]);
		const projectIndex = join(root, ".git", "index");
		writeFileSync(projectIndex, "sentinel");
		vi.stubEnv("GIT_DIR", join(root, ".git"));
		vi.stubEnv("GIT_WORK_TREE", root);
		vi.stubEnv("GIT_INDEX_FILE", projectIndex);
		await history.ensure();
		vi.unstubAllEnvs();
		git("config", "commit.gpgSign", "true");
		const hooks = join(ws, ".git", "hooks");
		mkdirSync(hooks, { recursive: true });
		writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		await history.snapshot("tool-1");
		expect(git("rev-list", "--count", "HEAD")).toBe("2");
		expect(readFileSync(projectIndex, "utf-8")).toBe("sentinel");
	});

	it("rejects a linked Git directory", async () => {
		const { root, ws, history } = fixture();
		mkdirSync(join(root, "other-git"));
		symlinkSync(join(root, "other-git"), join(ws, ".git"));
		await expect(history.ensure()).rejects.toThrow("requires its own .git directory");
	});

	it("resolves relative workspace paths before invoking Git", async () => {
		const { ws, git } = fixture();
		const history = new WorkspaceHistory(relative(process.cwd(), ws));
		await history.ensure();
		await history.snapshot("relative-path");
		expect(git("rev-list", "--count", "HEAD")).toBe("2");
	});
	function blockFilter(f: ReturnType<typeof fixture>) {
		const script = join(f.root, "filter.cjs");
		const ready = join(f.root, "filter-ready");
		const closed = join(f.root, "filter-closed");
		writeFileSync(
			script,
			`
const fs = require("node:fs");
process.on("SIGTERM", () => setTimeout(() => {
 fs.writeFileSync(${JSON.stringify(closed)}, "closed"); process.exit(143);
}, 150));
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 1000);
`,
		);
		f.git("config", "filter.block.clean", `'${process.execPath}' '${script}'`);
		f.git("config", "filter.block.required", "true");
		f.write(".gitattributes", "cell/src/main.rs filter=block\n");
		f.write("cell/src/main.rs", "changed cell\n");
		return { ready, closed };
	}

	it.each(["initial", "cell", "dependency"])("cancels a real Git %s snapshot and drains its filter", async (kind) => {
		const f = fixture();
		if (kind === "initial") f.git("init", "--quiet", "--template=");
		else await f.history.ensure();
		const { ready, closed } = blockFilter(f);
		const controller = new AbortController();
		const options = { signal: controller.signal };
		const pending = (
			kind === "initial"
				? f.history.ensure(options)
				: kind === "cell"
					? f.history.snapshot("cancelled-cell", options)
					: f.history.snapshotDependency("itoa", options)
		).catch((error: unknown) => error);
		try {
			await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000 });
			expect(existsSync(join(f.ws, ".git/index.lock"))).toBe(true);
			controller.abort(new Error("snapshot cancelled"));
			expect(await pending).toEqual(new Error("snapshot cancelled"));
			expect(existsSync(closed)).toBe(true);
			const pid = Number(readFileSync(ready, "utf8"));
			// Git may exit before init reaps its terminated filter on Linux.
			await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false));
			expect(existsSync(join(f.ws, ".git/index.lock"))).toBe(false);
			f.write(".gitattributes", "");
			await f.history.ensure();
			await f.history.snapshot("retry");
			expect(f.git("rev-list", "--count", "HEAD")).toBe("2");
			expect(f.git("fsck", "--no-dangling")).toBe("");
		} finally {
			controller.abort();
			await pending;
		}
	});

	it("times out a real Git command while preserving an existing foreign lock", async () => {
		const f = fixture();
		await f.history.ensure();
		const { ready } = blockFilter(f);
		await expect(f.history.snapshot("timeout", { timeoutMs: 2_000 })).rejects.toThrow("snapshot timed out");
		expect(existsSync(ready)).toBe(true);
		expect(existsSync(join(f.ws, ".git/index.lock"))).toBe(false);
		f.write(".gitattributes", "");
		f.write(".git/index.lock", "other owner");
		await expect(f.history.snapshot("foreign-lock")).rejects.toThrow("index.lock");
		expect(readFileSync(join(f.ws, ".git/index.lock"), "utf8")).toBe("other owner");
	});

	it("does not create Git state for pre-cancelled or expired operations", async () => {
		const f = fixture();
		await expect(f.history.ensure({ signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow(
			"cancelled",
		);
		await expect(f.history.ensure({ timeoutMs: 0 })).rejects.toThrow("snapshot timed out");
		expect(existsSync(join(f.ws, ".git"))).toBe(false);
	});

	it("serializes snapshots and counts time waiting for another operation", async () => {
		const f = fixture();
		await f.history.ensure();
		const { ready } = blockFilter(f);
		const controller = new AbortController();
		const active = f.history.snapshot("active", { signal: controller.signal }).catch((error: unknown) => error);
		try {
			await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000 });
			const queued = f.history.snapshot("expired", { timeoutMs: 1 }).catch((error: unknown) => error);
			controller.abort(new Error("cancelled"));
			expect(await active).toEqual(new Error("cancelled"));
			expect(String(await queued)).toContain("snapshot timed out");
			f.write(".gitattributes", "");
			await Promise.all([f.history.snapshot("one"), f.history.snapshot("two")]);
			expect(f.git("log", "-2", "--format=%s")).toBe("chore(cell): snapshot cell 2\nchore(cell): snapshot cell 1");
		} finally {
			controller.abort();
			await active;
		}
	});
	it("uses one budget across Git commands rather than resetting it per subprocess", async () => {
		const f = fixture();
		await f.history.ensure();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const run = cellProcess.runProcess;
		const budgets: number[] = [];
		vi.spyOn(cellProcess, "runProcess").mockImplementation(async (bin, args, options) => {
			budgets.push(options.timeoutMs);
			const result = await run(bin, args, options);
			now += 10_000;
			return result;
		});
		await expect(f.history.snapshot("expired")).rejects.toThrow("snapshot timed out");
		expect(budgets).toEqual([30_000, 20_000, 10_000]);
		expect(f.git("rev-list", "--count", "HEAD")).toBe("1");
	});

	it.each([false, true])("rejects overflow without truncating a large index (overflow=%s)", async (overflow) => {
		const f = fixture();
		f.write("state/saved", "saved");
		await f.history.ensure();
		rmSync(join(f.ws, "state"), { recursive: true });
		const run = cellProcess.runProcess;
		vi.spyOn(cellProcess, "runProcess").mockImplementation((bin, args, options) => {
			if (args.includes("ls-files")) {
				// Prefix enough irrelevant entries to exceed the process display cap.
				options.onChunk!("other/file\0".repeat(overflow ? 110_000 : 15_000), "stdout");
			}
			return run(bin, args, options);
		});
		if (overflow) {
			await expect(f.history.snapshot("large")).rejects.toThrow("output exceeded 1 MiB");
			expect(f.git("rev-list", "--count", "HEAD")).toBe("1");
		} else {
			await f.history.snapshot("large");
			expect(f.git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("state/saved");
		}
	});
});
