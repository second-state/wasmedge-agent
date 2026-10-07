import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
import { inspectWorkspaceStorage, type WorkspaceStorageReport } from "../src/core/rust-cell/storage.js";
import { acquireWorkspaceLease } from "../src/core/rust-cell/workspace-lease.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "workspace-storage-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const put = (name: string, text: string) => {
		const path = join(workspace, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	};
	for (const name of ["Cargo.toml", "agent_lib/Cargo.toml", "cell/Cargo.toml", "rlm/Cargo.toml"])
		put(name, "manifest");
	put(
		".workspace-version",
		JSON.stringify({
			schema: 1,
			templateHash: "template",
			dependencyHash: "deps",
			rustcVersion: "rustc",
			wasmedgeVersion: "wasmedge",
			sourceHashes: {},
		}),
	);
	put("target/artifact", "cache");
	put("target/cargo-sandbox/artifact", "sandbox");
	put("target/.agent-api.json", "api");
	put("state/blobs/keep", "state");
	put("vendor/keep", "vendor");
	put(".git/keep", "history");
	put("agent_lib/src/keep.rs", "source");
	put(".scratch/keep", "scratch");
	put("unknown/keep", "other");
	return { root, workspace, put };
}

describe("workspace storage", () => {
	it("reports categories and previews pruning without deleting data", async () => {
		const f = fixture();
		const report = await inspectWorkspaceStorage(f.workspace);
		expect(report.categories.find((usage) => usage.category === "cache")).toMatchObject({
			logicalBytes: 15,
			files: 3,
		});
		expect(report.categories.find((usage) => usage.category === "state")?.logicalBytes).toBe(5);
		expect(report.categories.find((usage) => usage.category === "dependencies")?.logicalBytes).toBe(6);
		expect(report.logicalBytes).toBe(report.categories.reduce((total, usage) => total + usage.logicalBytes, 0));
		expect(report.prune).toBeUndefined();
		const preview = await inspectWorkspaceStorage(f.workspace, { pruneCache: true });
		expect(preview.prune).toMatchObject({ logicalBytes: 15, applied: false });
		expect(readFileSync(join(f.workspace, "target/artifact"), "utf8")).toBe("cache");
	});

	it("removes only target, preserving persistent data, dependencies and unknown files", async () => {
		const f = fixture();
		const report = await inspectWorkspaceStorage(f.workspace, { pruneCache: true, apply: true });
		expect(report.prune).toMatchObject({ logicalBytes: 15, applied: true });
		expect(existsSync(join(f.workspace, "target"))).toBe(false);
		for (const path of [
			"state/blobs/keep",
			"vendor/keep",
			".git/keep",
			"agent_lib/src/keep.rs",
			".scratch/keep",
			"unknown/keep",
		]) {
			expect(existsSync(join(f.workspace, path))).toBe(true);
		}
		const empty = await inspectWorkspaceStorage(f.workspace, { pruneCache: true, apply: true });
		expect(empty.prune).toMatchObject({ logicalBytes: 0, applied: false });
	});

	it("refuses prune without a managed workspace marker or with malformed metadata", async () => {
		const f = fixture();
		rmSync(join(f.workspace, ".workspace-version"));
		await expect(inspectWorkspaceStorage(f.workspace, { pruneCache: true, apply: true })).rejects.toThrow();
		f.put(".workspace-version", "{}");
		await expect(inspectWorkspaceStorage(f.workspace, { pruneCache: true, apply: true })).rejects.toThrow(
			"workspace left unchanged",
		);
		expect(existsSync(join(f.workspace, "target/artifact"))).toBe(true);
	});

	it.skipIf(process.platform === "win32")("does not follow cache links or remove a hard-linked source", async () => {
		const f = fixture();
		const external = join(f.root, "external");
		mkdirSync(external);
		writeFileSync(join(external, "keep"), "external data");
		symlinkSync(external, join(f.workspace, "target/external"));
		linkSync(join(f.workspace, "state/blobs/keep"), join(f.workspace, "target/hardlink"));
		const report = await inspectWorkspaceStorage(f.workspace, { pruneCache: true, apply: true });
		expect(report.categories[0].symlinks).toBe(1);
		expect(report.categories[0].files).toBe(4);
		expect(readFileSync(join(external, "keep"), "utf8")).toBe("external data");
		expect(readFileSync(join(f.workspace, "state/blobs/keep"), "utf8")).toBe("state");
	});

	it.skipIf(process.platform === "win32")(
		"refuses a symlinked target even when it points inside the workspace",
		async () => {
			const f = fixture();
			rmSync(join(f.workspace, "target"), { recursive: true });
			symlinkSync(join(f.workspace, "state"), join(f.workspace, "target"));
			const usage = await inspectWorkspaceStorage(f.workspace);
			expect(usage.categories[0].files).toBe(0);
			await expect(inspectWorkspaceStorage(f.workspace, { pruneCache: true, apply: true })).rejects.toThrow(
				"real directory",
			);
			expect(readFileSync(join(f.workspace, "state/blobs/keep"), "utf8")).toBe("state");
		},
	);

	it("refuses cleanup while leased and bounds a second runtime's wait", async () => {
		const f = fixture();
		const ownerContext = new ProvisioningContext(new AbortController().signal, 10_000);
		const owner = await acquireWorkspaceLease(f.workspace, ownerContext, true);
		const waiterContext = new ProvisioningContext(new AbortController().signal, 100);
		try {
			await expect(inspectWorkspaceStorage(f.workspace, { pruneCache: true, apply: true })).rejects.toThrow(
				"Workspace is in use",
			);
			await expect(acquireWorkspaceLease(f.workspace, waiterContext, true)).rejects.toThrow("timed out");
			expect((await inspectWorkspaceStorage(f.workspace)).categories[0].logicalBytes).toBe(15);
		} finally {
			owner.release();
			ownerContext.dispose();
			waiterContext.dispose();
		}
		expect((await inspectWorkspaceStorage(f.workspace, { pruneCache: true, apply: true })).prune?.applied).toBe(true);
	});

	it("honors cancellation without removing cache data", async () => {
		const f = fixture();
		await expect(
			inspectWorkspaceStorage(f.workspace, {
				pruneCache: true,
				apply: true,
				signal: AbortSignal.abort(new Error("cancelled")),
			}),
		).rejects.toThrow("cancelled");
		expect(existsSync(join(f.workspace, "target/artifact"))).toBe(true);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"does not prune when the scan is incomplete",
		async () => {
			const f = fixture();
			chmodSync(join(f.workspace, "unknown"), 0);
			try {
				await expect(inspectWorkspaceStorage(f.workspace, { pruneCache: true, apply: true })).rejects.toThrow();
				expect(existsSync(join(f.workspace, "target/artifact"))).toBe(true);
			} finally {
				chmodSync(join(f.workspace, "unknown"), 0o755);
			}
		},
	);

	it("prints one JSON report and requires an explicit prune before apply", async () => {
		const f = fixture();
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		await runStorageCommand([f.workspace, "--json", "--prune-cache"]);
		expect(output).toHaveBeenCalledTimes(1);
		const report = JSON.parse(output.mock.calls[0][0]) as WorkspaceStorageReport;
		expect(report.prune?.applied).toBe(false);
		await expect(runStorageCommand([f.workspace, "--apply"])).rejects.toThrow("requires --prune-cache");
		await expect(runStorageCommand([f.workspace, "--unknown"])).rejects.toThrow("Unknown storage option");
		expect(existsSync(join(f.workspace, "target/artifact"))).toBe(true);
	});

	it("routes the CLI without a provider or toolchain and respects another process's lease", async () => {
		const f = fixture();
		const agentDir = join(f.root, "agent");
		const run = (...flags: string[]) =>
			spawnSync(
				process.execPath,
				[
					resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs"),
					resolve(__dirname, "../src/cli.ts"),
					"storage",
					f.workspace,
					"--json",
					...flags,
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
		const result = run();
		expect(result.status, result.stderr).toBe(0);
		expect((JSON.parse(result.stdout) as WorkspaceStorageReport).categories[0].logicalBytes).toBe(15);
		expect(existsSync(join(agentDir, "daemon"))).toBe(false);
		const context = new ProvisioningContext(new AbortController().signal, 30_000);
		const lease = await acquireWorkspaceLease(f.workspace, context, false);
		try {
			const refused = run("--prune-cache", "--apply");
			expect(refused.status).toBe(1);
			expect(refused.stderr).toContain("Workspace is in use");
			expect(existsSync(join(f.workspace, "target/artifact"))).toBe(true);
		} finally {
			lease.release();
			context.dispose();
		}
	}, 40_000);
});
