import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStorageCommand } from "../src/cli/storage.js";
import { ENV_AGENT_DIR } from "../src/config.js";
import { ProvisioningContext } from "../src/core/rust-cell/provisioning.js";
import * as storage from "../src/core/rust-cell/storage.js";
import { inspectArtifactsStorage, type WorkspaceStorageInventory } from "../src/core/rust-cell/storage-inventory.js";
import { acquireWorkspaceLease } from "../src/core/rust-cell/workspace-lease.js";
import { getSessionArtifactPath } from "../src/core/session-manager.js";

const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	process.exitCode = originalExitCode;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(path: string, content = "keep") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function workspace(container: string): string {
	const path = join(container, "workspace");
	for (const name of ["Cargo.toml", "agent_lib/Cargo.toml", "cell/Cargo.toml", "rlm/Cargo.toml"]) {
		put(join(path, name), "manifest");
	}
	put(
		join(path, ".workspace-version"),
		JSON.stringify({
			schema: 1,
			templateHash: "template",
			dependencyHash: "deps",
			rustcVersion: "rustc",
			wasmedgeVersion: "wasmedge",
			sourceHashes: {},
		}),
	);
	for (const name of [
		"target/cache",
		"vendor/dep",
		"state/data",
		".git/history",
		"agent_lib/src/lib.rs",
		"unknown/file",
	]) {
		put(join(path, name));
	}
	return path;
}

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "storage-inventory-")));
	roots.push(root);
	const artifacts = join(root, "session-artifacts");
	mkdirSync(artifacts);
	return { root, artifacts };
}

describe("session workspace storage", () => {
	it("discovers recursive inline child artifacts without daemon metadata", async () => {
		const f = fixture();
		const parent = join(f.artifacts, "parent");
		const childDir = join(parent, "sub-0123abcd");
		const grandchildDir = join(childDir, "sub-4567abcd");
		mkdirSync(grandchildDir, { recursive: true });
		const paths = [
			workspace(parent),
			workspace(getSessionArtifactPath(childDir, "child")),
			workspace(getSessionArtifactPath(grandchildDir, "grandchild")),
			workspace(getSessionArtifactPath(join(grandchildDir, "sub-89abcdef"), "great-grandchild")),
		];
		const report = await inspectArtifactsStorage(f.artifacts, { pruneCache: true, apply: true });
		expect(report.complete).toBe(true);
		expect(report.workspaces.map((entry) => entry.workspace)).toEqual(paths.sort());
		for (const path of paths) expect(existsSync(join(path, "target"))).toBe(false);
	});

	it("discovers parent, child and grandchild workspaces without traversing seeds or attachments", async () => {
		const f = fixture();
		const parent = join(f.artifacts, "parent");
		const child = join(parent, "sub-child");
		put(join(child, "rlm-subagent.json"), "{}");
		const paths = [
			workspace(parent),
			workspace(join(parent, "session-artifacts", "child-session")),
			workspace(join(child, "session-artifacts", "grandchild-session")),
		];
		// A session that never started its own runtime may still have child workspaces.
		paths.push(workspace(join(f.artifacts, "without-workspace", "session-artifacts", "child-session")));
		const ignored = [
			workspace(join(parent, ".rust-workspace-seed")),
			workspace(join(parent, "attachments", "session-artifacts", "not-a-session")),
			workspace(join(paths[0], "target", "session-artifacts", "not-a-session")),
		];
		const report = await inspectArtifactsStorage(f.artifacts, { pruneCache: true });
		expect(report.complete).toBe(true);
		expect(report.workspaces.map((entry) => entry.workspace)).toEqual(paths.sort());
		const expected = await Promise.all(paths.map((path) => storage.inspectWorkspaceStorage(path)));
		expect(report.logicalBytes).toBe(expected.reduce((sum, entry) => sum + entry.logicalBytes, 0));
		for (const path of [...paths, ...ignored]) expect(existsSync(join(path, "target/cache"))).toBe(true);
	});

	it("applies each cache prune while preserving persistent and unknown files", async () => {
		const f = fixture();
		const paths = [workspace(join(f.artifacts, "one")), workspace(join(f.artifacts, "two"))];
		const report = await inspectArtifactsStorage(f.artifacts, { pruneCache: true, apply: true });
		expect(report.complete).toBe(true);
		for (const entry of report.workspaces) {
			expect(entry).toMatchObject({ status: "ok", report: { prune: { applied: true, logicalBytes: 4 } } });
		}
		for (const path of paths) {
			expect(existsSync(join(path, "target"))).toBe(false);
			for (const name of ["vendor/dep", "state/data", ".git/history", "agent_lib/src/lib.rs", "unknown/file"]) {
				expect(readFileSync(join(path, name), "utf8")).toBe("keep");
			}
		}
	});

	it("reports malformed workspaces and continues without counting them in the subtotal", async () => {
		const f = fixture();
		const invalid = workspace(join(f.artifacts, "invalid"));
		const valid = workspace(join(f.artifacts, "valid"));
		put(join(invalid, ".workspace-version"), "{}");
		const expected = await storage.inspectWorkspaceStorage(valid);
		const report = await inspectArtifactsStorage(f.artifacts, { pruneCache: true, apply: true });
		expect(report.complete).toBe(false);
		expect(report.logicalBytes).toBe(expected.logicalBytes);
		expect(report.workspaces[0]).toMatchObject({ workspace: invalid, status: "error" });
		expect(report.workspaces[1]).toMatchObject({ workspace: valid, status: "ok" });
		expect(existsSync(join(invalid, "target/cache"))).toBe(true);
		expect(existsSync(join(valid, "target"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")("does not follow session or workspace symlinks", async () => {
		const f = fixture();
		const external = workspace(join(f.root, "external"));
		symlinkSync(dirname(external), join(f.artifacts, "linked-session"));
		mkdirSync(join(f.artifacts, "session"));
		symlinkSync(external, join(f.artifacts, "session", "workspace"));
		symlinkSync(f.artifacts, join(f.artifacts, "session", "session-artifacts"));
		const report = await inspectArtifactsStorage(f.artifacts, { pruneCache: true, apply: true });
		expect(report.complete).toBe(false);
		expect(report.workspaces).toHaveLength(1);
		expect(report.workspaces[0]).toMatchObject({ status: "error", error: expect.stringContaining("real directory") });
		expect(existsSync(join(external, "target/cache"))).toBe(true);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"finishes discovery before removing any cache",
		async () => {
			const f = fixture();
			const valid = workspace(join(f.artifacts, "a-valid"));
			const blocked = join(f.artifacts, "z-unreadable");
			mkdirSync(blocked);
			chmodSync(blocked, 0);
			try {
				await expect(inspectArtifactsStorage(f.artifacts, { pruneCache: true, apply: true })).rejects.toThrow();
				expect(existsSync(join(valid, "target/cache"))).toBe(true);
			} finally {
				chmodSync(blocked, 0o755);
			}
		},
	);

	it("honors cancellation before discovery and between workspaces", async () => {
		const f = fixture();
		const first = workspace(join(f.artifacts, "a"));
		const second = workspace(join(f.artifacts, "b"));
		await expect(
			inspectArtifactsStorage(f.artifacts, {
				pruneCache: true,
				apply: true,
				signal: AbortSignal.abort(new Error("cancelled")),
			}),
		).rejects.toThrow("cancelled");
		expect(existsSync(join(first, "target/cache"))).toBe(true);
		const controller = new AbortController();
		const inspect = storage.inspectWorkspaceStorage;
		vi.spyOn(storage, "inspectWorkspaceStorage").mockImplementationOnce(async (path, options) => {
			const result = await inspect(path, options);
			controller.abort();
			return result;
		});
		const report = await inspectArtifactsStorage(f.artifacts, {
			pruneCache: true,
			apply: true,
			signal: controller.signal,
		});
		expect(report.complete).toBe(false);
		expect(report.workspaces.map((entry) => entry.status)).toEqual(["ok", "skipped"]);
		expect(existsSync(join(first, "target"))).toBe(false);
		expect(existsSync(join(second, "target/cache"))).toBe(true);
	});

	it("shares a single deadline across the batch", async () => {
		const f = fixture();
		const first = workspace(join(f.artifacts, "a"));
		const second = workspace(join(f.artifacts, "b"));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		vi.spyOn(storage, "inspectWorkspaceStorage").mockImplementationOnce(async (_path, options) => {
			await vi.advanceTimersByTimeAsync(100);
			options?.signal?.throwIfAborted();
			throw new Error("batch did not time out");
		});
		const report = await inspectArtifactsStorage(f.artifacts, { pruneCache: true, apply: true, timeoutMs: 100 });
		expect(report.complete).toBe(false);
		expect(report.workspaces[0]).toMatchObject({ status: "error", error: expect.stringContaining("timed out") });
		expect(report.workspaces[1]).toMatchObject({ status: "skipped" });
		for (const path of [first, second]) expect(existsSync(join(path, "target/cache"))).toBe(true);
	});

	it("handles empty roots and validates options before discovery", async () => {
		const f = fixture();
		expect(await inspectArtifactsStorage(f.artifacts)).toEqual({
			artifactsRoot: f.artifacts,
			complete: true,
			logicalBytes: 0,
			workspaces: [],
		});
		await expect(inspectArtifactsStorage(f.artifacts, { apply: true })).rejects.toThrow("requires --prune-cache");
		await expect(inspectArtifactsStorage(f.artifacts, { timeoutMs: 0 })).rejects.toThrow("timeoutMs");
		await expect(inspectArtifactsStorage(join(f.root, "missing"))).rejects.toThrow();
	});

	it("validates the CLI selector and prints one JSON inventory", async () => {
		const f = fixture();
		workspace(join(f.artifacts, "one"));
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		await runStorageCommand(["--json", "--artifacts", f.artifacts, "--prune-cache"]);
		expect(output).toHaveBeenCalledTimes(1);
		const report = JSON.parse(output.mock.calls[0][0]) as WorkspaceStorageInventory;
		expect(report.complete).toBe(true);
		expect(report.workspaces).toHaveLength(1);
		await expect(runStorageCommand(["--artifacts"])).rejects.toThrow("directory path");
		await expect(runStorageCommand(["--artifacts", "--json"])).rejects.toThrow("directory path");
		await expect(runStorageCommand(["--artifacts", f.artifacts, "--artifacts", f.artifacts])).rejects.toThrow("once");
		await expect(runStorageCommand(["--artifacts", f.artifacts, f.root])).rejects.toThrow("not both");
	});

	it("labels incomplete text output and returns a failing exit code", async () => {
		const f = fixture();
		workspace(join(f.artifacts, "valid"));
		mkdirSync(join(f.artifacts, "invalid", "workspace"), { recursive: true });
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		await runStorageCommand(["--artifacts", f.artifacts, "--prune-cache"]);
		const text = output.mock.calls.flat().join("\n");
		expect(text).toContain("1/2 workspaces");
		expect(text).toContain("Incomplete: totals exclude");
		expect(text).toContain("prune preview");
		expect(process.exitCode).toBe(1);
	});

	it("prunes idle workspaces and reports busy ones in one JSON document without starting a toolchain", async () => {
		const f = fixture();
		const busy = workspace(join(f.artifacts, "busy"));
		const idle = workspace(join(f.artifacts, "idle"));
		const context = new ProvisioningContext(new AbortController().signal, 30_000);
		const lease = await acquireWorkspaceLease(busy, context, false);
		const agentDir = join(f.root, "agent");
		try {
			const result = spawnSync(
				process.execPath,
				[
					resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs"),
					resolve(__dirname, "../src/cli.ts"),
					"storage",
					"--artifacts",
					f.artifacts,
					"--prune-cache",
					"--apply",
					"--json",
				],
				{
					encoding: "utf8",
					timeout: 30_000,
					env: {
						...process.env,
						HOME: f.root,
						USERPROFILE: f.root,
						[ENV_AGENT_DIR]: agentDir,
						PI_SKIP_VERSION_CHECK: "1",
						WASMEDGE_AGENT_CARGO: join(f.root, "no-cargo"),
						WASMEDGE_AGENT_WASMEDGE: join(f.root, "no-wasmedge"),
					},
				},
			);
			expect(result.status, result.stderr).toBe(1);
			const report = JSON.parse(result.stdout) as WorkspaceStorageInventory;
			expect(report.complete).toBe(false);
			expect(report.workspaces[0]).toMatchObject({
				status: "skipped",
				error: expect.stringContaining("Workspace is in use"),
			});
			expect(report.workspaces[1]).toMatchObject({ status: "ok", report: { prune: { applied: true } } });
			expect(existsSync(join(busy, "target/cache"))).toBe(true);
			expect(existsSync(join(idle, "target"))).toBe(false);
			expect(existsSync(join(agentDir, "daemon"))).toBe(false);
		} finally {
			lease.release();
			context.dispose();
		}
	}, 40_000);
});
