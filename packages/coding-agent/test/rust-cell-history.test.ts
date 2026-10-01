import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHistory } from "../src/core/rust-cell/workspace-history.js";

describe("session workspace history", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
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

	it("records source and state, including deletions, and resumes cell numbering", () => {
		const { ws, write, git, history } = fixture();
		history.ensure();
		write("cell/src/main.rs", 'fn main() { println!("one"); }\n');
		write("agent_lib/src/helpers/one.rs", "pub fn one() {}\n");
		write("state/state.json", '{"counter":1}');
		write("state/blobs/data.bin", "blob");
		for (const path of ["target/cell.wasm", "vendor/crate/lib.rs", ".scratch/tmp", "unrelated.txt"])
			write(path, "omit");
		const first = history.snapshot("tool-call-1");
		expect(git("show", `${first}:state/state.json`)).toBe('{"counter":1}');
		expect(git("show", `${first}:state/blobs/data.bin`)).toBe("blob");
		expect(git("log", "-1", "--format=%B")).toContain('Tool-Call-ID: "tool-call-1"');
		expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/target|vendor|scratch|unrelated/);
		rmSync(join(ws, "agent_lib/src/helpers/one.rs"));
		const resumed = new WorkspaceHistory(ws);
		resumed.ensure();
		resumed.snapshot("tool-call-2");
		expect(git("log", "-1", "--format=%s")).toBe("chore(cell): snapshot cell 2");
		expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("one.rs");
		resumed.snapshot("tool-call-3");
		expect(git("rev-list", "--count", "HEAD")).toBe("4");
	});

	it("leaves unrelated staged files out of a snapshot", () => {
		const { write, git, history } = fixture();
		history.ensure();
		write("private.txt", "not a workspace artifact");
		git("add", "private.txt");
		history.snapshot("tool-1");
		expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("private.txt");
		expect(git("diff", "--cached", "--name-only")).toBe("private.txt");
	});

	it("ignores inherited Git destinations and hooks without touching the enclosing project", () => {
		const { root, ws, git, history } = fixture();
		execFileSync("git", ["init", "--quiet", root]);
		const projectIndex = join(root, ".git", "index");
		writeFileSync(projectIndex, "sentinel");
		vi.stubEnv("GIT_DIR", join(root, ".git"));
		vi.stubEnv("GIT_WORK_TREE", root);
		vi.stubEnv("GIT_INDEX_FILE", projectIndex);
		history.ensure();
		vi.unstubAllEnvs();
		git("config", "commit.gpgSign", "true");
		const hooks = join(ws, ".git", "hooks");
		mkdirSync(hooks, { recursive: true });
		writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		history.snapshot("tool-1");
		expect(git("rev-list", "--count", "HEAD")).toBe("2");
		expect(readFileSync(projectIndex, "utf-8")).toBe("sentinel");
	});

	it("rejects a linked Git directory", () => {
		const { root, ws, history } = fixture();
		mkdirSync(join(root, "other-git"));
		symlinkSync(join(root, "other-git"), join(ws, ".git"));
		expect(() => history.ensure()).toThrow("requires its own .git directory");
	});

	it("resolves relative workspace paths before invoking Git", () => {
		const { ws, git } = fixture();
		const history = new WorkspaceHistory(relative(process.cwd(), ws));
		history.ensure();
		history.snapshot("relative-path");
		expect(git("rev-list", "--count", "HEAD")).toBe("2");
	});
});
