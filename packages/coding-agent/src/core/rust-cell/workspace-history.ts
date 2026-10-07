import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runProcess } from "./process.js";

const TRACKED_PATHS = [
	".gitignore",
	".cargo/config.toml",
	".skills-hash",
	".inherited-workspace",
	".workspace-version",
	".cell-dependencies.json",
	"Cargo.toml",
	"Cargo.lock",
	"agent_lib/Cargo.toml",
	"agent_lib/src",
	"cell/Cargo.toml",
	"cell/src",
	"rlm/Cargo.toml",
	"rlm/src",
	"skills",
	"state",
];

export interface HistoryOptions {
	signal?: AbortSignal;
	/** Whole-operation budget including queueing, capped at 30 seconds. */
	timeoutMs?: number;
}

type GitCommand = (args: string[]) => Promise<string>;

/** Local snapshots of a persisted session workspace (DESIGN.md D5).
 * Explicit git/work-tree paths and a clean Git environment prevent an
 * enclosing project or an inherited GIT_INDEX_FILE from receiving writes. */
export class WorkspaceHistory {
	private readonly workspaceDir: string;
	private pending: Promise<unknown> = Promise.resolve();
	constructor(workspaceDir: string) {
		this.workspaceDir = resolve(workspaceDir);
	}

	private operation<T>(options: HistoryOptions, action: (git: GitCommand) => Promise<T>): Promise<T> {
		const timeoutMs = Math.min(options.timeoutMs ?? 30_000, 30_000);
		const deadline = performance.now() + timeoutMs;
		const check = () => {
			options.signal?.throwIfAborted();
			if (performance.now() >= deadline) throw new Error("Workspace Git snapshot timed out");
		};
		const git: GitCommand = async (args) => {
			check();
			const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
			let stdout = "";
			let overflow = false;
			let stdoutBytes = 0;
			const result = await runProcess(
				"git",
				[
					"-C",
					this.workspaceDir,
					`--git-dir=${join(this.workspaceDir, ".git")}`,
					`--work-tree=${this.workspaceDir}`,
					"-c",
					"user.name=WasmEdge Agent",
					"-c",
					"user.email=wasmedge-agent@localhost",
					"-c",
					"commit.gpgSign=false",
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"core.fsmonitor=false",
					// Upgrades must not copy .git while background maintenance still writes it.
					"-c",
					"maintenance.autoDetach=false",
					"-c",
					"gc.autoDetach=false",
					...args,
				],
				{
					cwd: this.workspaceDir,
					env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
					timeoutMs: Math.max(0, deadline - performance.now()),
					signal: options.signal,
					terminateGraceMs: 1_000,
					onChunk: (chunk, stream) => {
						if (stream !== "stdout" || overflow) return;
						// ls-files must never consume runProcess's truncated display output.
						stdoutBytes += Buffer.byteLength(chunk);
						if (stdoutBytes > 1_048_576) overflow = true;
						else stdout += chunk;
					},
				},
			);
			check();
			if (result.timedOut) throw new Error("Workspace Git snapshot timed out");
			if (result.exitCode !== 0) throw new Error(`Workspace Git ${args[0]} failed: ${result.stderr || stdout}`);
			if (overflow) throw new Error("Workspace Git output exceeded 1 MiB");
			return stdout.trim();
		};
		const result = this.pending.then(() => {
			check();
			return action(git);
		});
		this.pending = result.catch(() => {});
		return result;
	}

	ensure(options: HistoryOptions = {}): Promise<void> {
		return this.operation(options, async (git) => {
			const gitDir = join(this.workspaceDir, ".git");
			const stat = lstatSync(gitDir, { throwIfNoEntry: false });
			if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
				throw new Error("Session workspace history requires its own .git directory");
			}
			await git(["init", "--quiet", "--template="]);
			const ignore = join(this.workspaceDir, ".gitignore");
			if (!existsSync(ignore)) writeFileSync(ignore, "/target/\n/vendor/\n/.scratch/\n");
			if (!(await git(["rev-list", "--all", "--count"])).match(/^[1-9]/)) {
				await this.commit(git, "chore(workspace): initialize session snapshot");
			}
		});
	}

	snapshot(cellId: string, options: HistoryOptions = {}): Promise<string> {
		return this.operation(options, async (git) => {
			const sequence = await git(["rev-list", "--count", "HEAD"]);
			return this.commit(git, `chore(cell): snapshot cell ${sequence}`, `Tool-Call-ID: ${JSON.stringify(cellId)}`);
		});
	}

	snapshotDependency(name: string, options: HistoryOptions = {}): Promise<string> {
		return this.operation(options, (git) => this.commit(git, `chore(deps): add ${name}`));
	}

	private async commit(git: GitCommand, subject: string, body?: string): Promise<string> {
		const tracked = (await git(["ls-files", "-z"])).split("\0");
		const paths = TRACKED_PATHS.filter(
			(path) =>
				lstatSync(join(this.workspaceDir, path), { throwIfNoEntry: false }) ||
				tracked.some((file) => file === path || file.startsWith(`${path}/`)),
		);
		await git(["add", "--all", "--force", "--", ...paths]);
		const known = [...tracked, ...(await git(["ls-files", "-z"])).split("\0")];
		const commitPaths = paths.filter((path) => known.some((file) => file === path || file.startsWith(`${path}/`)));
		await git([
			"commit",
			"--quiet",
			"--only",
			"--allow-empty",
			"-m",
			subject,
			...(body ? ["-m", body] : []),
			"--",
			...commitPaths,
		]);
		return git(["rev-parse", "HEAD"]);
	}
}
