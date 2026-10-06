import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustCellProvisioner, type RustCellProvisionerOptions } from "../src/core/rust-cell/index.js";
import * as cellProcess from "../src/core/rust-cell/process.js";
import { SkillValidation } from "../src/core/rust-cell/skill-validation.js";
import * as toolchain from "../src/core/rust-cell/toolchain.js";
import { WorkspaceHistory } from "../src/core/rust-cell/workspace-history.js";
import * as workspaceVersion from "../src/core/rust-cell/workspace-version.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const roots: string[] = [];
const provisioners: RustCellProvisioner[] = [];
afterEach(async () => {
	for (const provisioner of provisioners.splice(0)) await provisioner.dispose();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: Partial<RustCellProvisionerOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "cell-lifecycle-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	mkdirSync(join(workspace, "cell/src"), { recursive: true });
	mkdirSync(join(workspace, "agent_lib/src"), { recursive: true });
	writeFileSync(join(workspace, "Cargo.toml"), "[workspace]\n");
	writeFileSync(join(workspace, "cell/src/main.rs"), "previous cell");
	writeFileSync(join(workspace, "agent_lib/src/lib.rs"), "previous library");
	vi.spyOn(toolchain, "resolveToolchain").mockReturnValue({
		cargoBin: "cargo",
		wasmedgeBin: "wasmedge",
		wasmedgeVersion: "test",
	});
	vi.spyOn(toolchain, "rustcVersion").mockReturnValue("test");
	vi.spyOn(toolchain, "ensureTemplateReady").mockImplementation(() => {});
	vi.spyOn(workspaceVersion, "prepareVersionedWorkspace").mockImplementation(() => {});
	vi.spyOn(WorkspaceHistory.prototype, "ensure").mockImplementation(() => {});
	const provisioner = new RustCellProvisioner({ cwd: root, workspaceDir: workspace, ...options });
	provisioners.push(provisioner);
	return { root, workspace, provisioner };
}

describe("runtime disposal", () => {
	it("aborts and drains builds, cancels queued cells, and permits a fresh runner", async () => {
		const { workspace, provisioner } = fixture();
		const runner = await provisioner.ensure();
		const entered = deferred<AbortSignal>();
		const build = deferred<cellProcess.ProcOutcome>();
		const processes = vi.spyOn(cellProcess, "runProcess").mockImplementation((_bin, _args, options) => {
			entered.resolve(options.signal!);
			return build.promise;
		});
		const input = { code: "next cell", lib: [{ path: "src/lib.rs", content: "next library" }] };
		const active = runner.execute(input);
		const queued = runner.execute(input);
		const signal = await entered.promise;
		let disposed = false;
		const stopping = provisioner.dispose().then(() => {
			disposed = true;
		});
		const restarted = provisioner.ensure();
		let restartFinished = false;
		void restarted.then(() => {
			restartFinished = true;
		});
		try {
			expect(signal.aborted).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(disposed).toBe(false);
			expect(restartFinished).toBe(false);
			build.resolve({ exitCode: null, stdout: "", stderr: "", aborted: true, timedOut: false });
			await stopping;
			expect(await active).toMatchObject({ status: "aborted", libReverted: true });
			expect(await queued).toMatchObject({ status: "aborted", libApplied: false });
			expect(readFileSync(join(workspace, "cell/src/main.rs"), "utf8")).toBe("previous cell");
			expect(readFileSync(join(workspace, "agent_lib/src/lib.rs"), "utf8")).toBe("previous library");
			expect(await runner.execute(input)).toMatchObject({ status: "aborted", libApplied: false });
			expect(processes).toHaveBeenCalledTimes(1);
			expect(await restarted).not.toBe(runner);
		} finally {
			build.resolve({ exitCode: null, stdout: "", stderr: "", aborted: true, timedOut: false });
			await Promise.allSettled([active, queued, stopping, restarted]);
		}
	});

	it("keeps the teardown barrier when an unused replacement is disposed", async () => {
		const previous = deferred<void>();
		const { root, workspace, provisioner } = fixture({ beforeStart: previous.promise });
		const stopped = provisioner.dispose();
		const next = new RustCellProvisioner({ cwd: root, workspaceDir: workspace, beforeStart: stopped });
		provisioners.push(next);
		const starting = next.ensure();
		let started = false;
		void starting.then(() => {
			started = true;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(started).toBe(false);
			expect(toolchain.resolveToolchain).not.toHaveBeenCalled();
			previous.resolve();
			expect(await starting).toBeDefined();
			expect(toolchain.resolveToolchain).toHaveBeenCalledTimes(1);
		} finally {
			previous.resolve();
			await Promise.allSettled([stopped, starting]);
		}
	});

	it("rejects startup if the previous runtime failed to stop", async () => {
		const { provisioner } = fixture({ beforeStart: Promise.reject(new Error("teardown failed")) });
		await expect(provisioner.ensure()).rejects.toThrow("teardown failed");
		expect(toolchain.resolveToolchain).not.toHaveBeenCalled();
		await expect(provisioner.dispose()).rejects.toThrow("teardown failed");
		provisioners.splice(provisioners.indexOf(provisioner), 1);
	});

	it("disposes a runner created after a startup callback requests shutdown", async () => {
		const { provisioner } = fixture();
		let stopping: Promise<void> | undefined;
		const starting = provisioner.ensure(() => {
			stopping ??= provisioner.dispose();
		});
		await expect(starting).rejects.toThrow("runtime disposed");
		await stopping;
		expect(provisioner.hasRunner).toBe(false);
		expect(provisioner.bridge).toBeUndefined();
	});

	it("does not restore a runner from startup after disposal", async () => {
		const { provisioner } = fixture();
		const starting = provisioner.ensure();
		const outcome = starting.catch((error: unknown) => error);
		await provisioner.dispose();
		expect(await outcome).toBeInstanceOf(Error);
		expect(provisioner.hasRunner).toBe(false);
		expect(provisioner.bridge).toBeUndefined();
		expect(await provisioner.ensure()).toBeDefined();
		expect(provisioner.hasRunner).toBe(true);
	});

	it("cancels skill tests and waits for their cleanup", async () => {
		const { provisioner } = fixture();
		const entered = deferred<AbortSignal>();
		const testing = deferred<void>();
		vi.spyOn(SkillValidation.prototype, "test").mockImplementation((_reference, signal) => {
			entered.resolve(signal!);
			return testing.promise;
		});
		const tested = provisioner.testSkill({ type: "rust", use: "agent_lib::skills::example" });
		const outcome = tested.catch((error: unknown) => error);
		const signal = await entered.promise;
		let disposed = false;
		const stopping = provisioner.dispose().then(() => {
			disposed = true;
		});
		try {
			expect(signal.aborted).toBe(true);
			await Promise.resolve();
			expect(disposed).toBe(false);
			testing.reject(signal.reason);
			await stopping;
			expect(await outcome).toBeInstanceOf(Error);
		} finally {
			testing.reject(new Error("test cleanup"));
			await Promise.allSettled([tested, stopping]);
		}
	});
});
