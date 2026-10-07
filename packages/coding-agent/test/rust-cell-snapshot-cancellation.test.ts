import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testRustCrate } from "../src/core/rust-cell/crate-tests.js";
import { createDependencyHandler } from "../src/core/rust-cell/dependencies.js";
import * as cellProcess from "../src/core/rust-cell/process.js";
import { createRustdocHandler } from "../src/core/rust-cell/rustdoc.js";
import * as snapshots from "../src/core/rust-cell/workspace-snapshot.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "snapshot-cancellation-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	for (const path of [".cargo", "agent_lib/src", "cell/src", "rlm/src", "vendor"])
		mkdirSync(join(workspace, path), { recursive: true });
	for (const path of [
		"Cargo.toml",
		"Cargo.lock",
		".cargo/config.toml",
		"agent_lib/Cargo.toml",
		"agent_lib/src/lib.rs",
		"cell/Cargo.toml",
		"cell/src/main.rs",
		"rlm/src/lib.rs",
	]) {
		writeFileSync(join(workspace, path), "original");
	}
	writeFileSync(join(workspace, ".workspace-version"), "{}");
	return { root, workspace };
}

describe("runtime snapshot callers", () => {
	it.each(["tests", "dependencies", "rustdoc"])(
		"cancels %s snapshot preparation and waits for cleanup before returning",
		async (kind) => {
			const f = fixture();
			const controller = new AbortController();
			const copy = snapshots.snapshotWorkspace;
			let release!: () => void;
			const draining = new Promise<void>((resolve) => {
				release = resolve;
			});
			let active: { signal: AbortSignal; root: string } | undefined;
			vi.spyOn(snapshots, "snapshotWorkspace").mockImplementationOnce(async (source, destination, options) => {
				await copy(source, destination, options);
				active = { signal: options!.signal!, root: dirname(destination) };
				await draining;
				options!.signal!.throwIfAborted();
			});
			const run = vi.spyOn(cellProcess, "runProcess").mockImplementation(async (_bin, args) => {
				if (!args.includes("--version")) throw new Error("should not start Cargo");
				return { exitCode: 0, stdout: "rustc test", stderr: "", timedOut: false, aborted: false };
			});
			const pending = (
				kind === "tests"
					? testRustCrate("agent_lib", {
							workspaceDir: f.workspace,
							cargoBin: "unused",
							wasmedgeBin: "unused",
							timeoutMs: 10_000,
							signal: controller.signal,
						})
					: kind === "dependencies"
						? createDependencyHandler({
								workspace: f.workspace,
								template: f.workspace,
								cargoBin: "unused",
								configured: [],
								timeoutMs: 10_000,
							})({ crate_name: "itoa" }, { signal: controller.signal })
						: createRustdocHandler({
								workspace: f.workspace,
								toolchain: "nightly-test",
								timeoutMs: 10_000,
							})({ path: "agent_lib" }, { signal: controller.signal })
			).catch((error: unknown) => error);
			try {
				await vi.waitFor(() => expect(active).toBeDefined());
				let settled = false;
				void pending.then(() => {
					settled = true;
				});
				controller.abort(new Error("caller cancelled"));
				expect(active!.signal.aborted).toBe(true);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);
				expect(existsSync(active!.root)).toBe(true);
				release();
				expect(await pending).toEqual(new Error("caller cancelled"));
				expect(existsSync(active!.root)).toBe(false);
				expect(readFileSync(join(f.workspace, "Cargo.toml"), "utf8")).toBe("original");
				expect(existsSync(join(f.workspace, ".cell-dependencies.json"))).toBe(false);
				expect(existsSync(join(f.workspace, "target/.agent-api.json"))).toBe(false);
				expect(run).toHaveBeenCalledTimes(kind === "rustdoc" ? 1 : 0);
			} finally {
				release();
				await pending;
			}
		},
	);
});
