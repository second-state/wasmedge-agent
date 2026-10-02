import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

/** Local snapshots of a persisted session workspace (DESIGN.md D5).
 * Explicit git/work-tree paths and a clean Git environment prevent an
 * enclosing project or an inherited GIT_INDEX_FILE from receiving writes. */
export class WorkspaceHistory {
	private readonly workspaceDir: string;
	constructor(workspaceDir: string) {
		this.workspaceDir = resolve(workspaceDir);
	}

	private git(args: string[]): string {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		return execFileSync(
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
				...args,
			],
			{
				env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 30_000,
			},
		).trim();
	}

	ensure(): void {
		const gitDir = join(this.workspaceDir, ".git");
		const stat = lstatSync(gitDir, { throwIfNoEntry: false });
		if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
			throw new Error("Session workspace history requires its own .git directory");
		}
		this.git(["init", "--quiet", "--template="]);
		const ignore = join(this.workspaceDir, ".gitignore");
		if (!existsSync(ignore)) writeFileSync(ignore, "/target/\n/vendor/\n/.scratch/\n");
		if (!this.git(["rev-list", "--all", "--count"]).match(/^[1-9]/)) {
			this.commit("chore(workspace): initialize session snapshot");
		}
	}

	snapshot(cellId: string): string {
		const sequence = this.git(["rev-list", "--count", "HEAD"]);
		return this.commit(`chore(cell): snapshot cell ${sequence}`, `Tool-Call-ID: ${JSON.stringify(cellId)}`);
	}

	snapshotDependency(name: string): string {
		return this.commit(`chore(deps): add ${name}`);
	}

	private commit(subject: string, body?: string): string {
		const tracked = this.git(["ls-files", "-z"]).split("\0");
		const paths = TRACKED_PATHS.filter(
			(path) =>
				lstatSync(join(this.workspaceDir, path), { throwIfNoEntry: false }) ||
				tracked.some((file) => file === path || file.startsWith(`${path}/`)),
		);
		this.git(["add", "--all", "--force", "--", ...paths]);
		const known = [...tracked, ...this.git(["ls-files", "-z"]).split("\0")];
		const commitPaths = paths.filter((path) => known.some((file) => file === path || file.startsWith(`${path}/`)));
		this.git([
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
		return this.git(["rev-parse", "HEAD"]);
	}
}
