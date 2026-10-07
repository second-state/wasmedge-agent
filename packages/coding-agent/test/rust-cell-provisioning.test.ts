import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withBuildPermit } from "../src/core/rust-cell/build-gate.js";
import { RustCellProvisioner, type RustCellProvisionerOptions } from "../src/core/rust-cell/index.js";
import { ProvisioningContext } from "../src/core/rust-cell/provisioning.js";
import { ensureTemplateReadyAsync } from "../src/core/rust-cell/toolchain.js";
import { mountedSkillCrates, resolveTemplateDir, syncRustSkillsAsync } from "../src/core/rust-cell/workspace.js";
import * as workspaceFiles from "../src/core/rust-cell/workspace-files.js";
import { WorkspaceHistory } from "../src/core/rust-cell/workspace-history.js";
import { createRustTool } from "../src/core/tools/rust.js";

const sourceTemplate = resolveTemplateDir();
const roots: string[] = [];
const runtimes: RustCellProvisioner[] = [];
const contexts: ProvisioningContext[] = [];
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
	for (const context of contexts.splice(0)) context.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "cell-provisioning-"));
	roots.push(root);
	const template = join(root, "template");
	const workspace = join(root, "workspace");
	cpSync(sourceTemplate, template, {
		recursive: true,
		filter: (path) => !["target", "vendor"].includes(basename(path)),
	});
	const bins = join(root, "bin");
	mkdirSync(bins);
	for (const binary of ["cargo", "rustc", "rustup", "wasmedge"]) {
		writeFileSync(
			join(bins, binary),
			`#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const root = ${JSON.stringify(root)};
const binary = path.basename(__filename), args = process.argv.slice(2);
const phase = binary !== "cargo" ? binary : args[0] === "vendor" ? "vendor" : args.at(-1) === "cell" ? "build" : args.at(-1);
fs.appendFileSync(path.join(root, "calls"), phase + "\\n");
function complete() {
 if (binary === "rustup") console.log("wasm32-wasip1");
 else if (binary !== "cargo") console.log(binary + " test");
 else if (args[0] === "vendor") fs.mkdirSync(args.at(-1), {recursive: true});
 else {
  const target = path.join(process.cwd(), "target/wasm32-wasip1/release");
  fs.mkdirSync(target, {recursive: true}); fs.writeFileSync(path.join(target, "cell.wasm"), "test");
 }
}
if (fs.existsSync(path.join(root, "block-" + phase))) {
 const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "inherit"});
 fs.writeFileSync(path.join(root, "entered-" + phase), String(process.pid));
 const timer = setInterval(() => {
  if (!fs.existsSync(path.join(root, "block-" + phase))) { clearInterval(timer); child.kill(); complete(); }
 }, 10);
} else if (fs.existsSync(path.join(root, "fail-" + phase))) { console.error("bad skill"); process.exitCode = 1; }
else complete();
`,
			{ mode: 0o755 },
		);
	}
	vi.stubEnv("PATH", `${bins}:${process.env.PATH}`);
	vi.stubEnv("RUSTC", join(bins, "rustc"));
	vi.stubEnv("WASMEDGE_AGENT_CARGO", join(bins, "cargo"));
	vi.stubEnv("WASMEDGE_AGENT_WASMEDGE", join(bins, "wasmedge"));
	vi.stubEnv("WASMEDGE_AGENT_TEMPLATE_DIR", template);
	vi.stubEnv("WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS", "1");
	const runtime = (options: Partial<RustCellProvisionerOptions> = {}) => {
		const provisioner = new RustCellProvisioner({ cwd: root, workspaceDir: workspace, ...options });
		runtimes.push(provisioner);
		return provisioner;
	};
	const warm = () => {
		mkdirSync(join(template, "vendor"), { recursive: true });
		mkdirSync(join(template, "target/wasm32-wasip1/release"), { recursive: true });
		writeFileSync(join(template, "target/wasm32-wasip1/release/cell.wasm"), "test");
	};
	const block = (phase: string) => writeFileSync(join(root, `block-${phase}`), "");
	const unblock = (phase: string) => rmSync(join(root, `block-${phase}`));
	const entered = (phase: string) =>
		vi.waitFor(() => expect(existsSync(join(root, `entered-${phase}`))).toBe(true), { timeout: 5000, interval: 10 });
	const context = (controller = new AbortController(), timeout = 10_000) => {
		const context = new ProvisioningContext(controller.signal, timeout);
		contexts.push(context);
		return context;
	};
	return { root, template, workspace, cargo: join(bins, "cargo"), runtime, warm, block, unblock, entered, context };
}

describe("cancellable runtime provisioning", () => {
	it.each([null, 0, -1, 1.5, Infinity, NaN, 2_147_483_648, "1000"])("rejects invalid startup budget %s", (value) => {
		expect(() => new RustCellProvisioner({ cwd: "/unused", provisionTimeoutMs: value as number })).toThrow(
			"provisionTimeoutMs",
		);
	});

	it("does not start pre-cancelled work", async () => {
		const f = fixture();
		const signal = AbortSignal.abort(new Error("cancelled"));
		await expect(f.runtime().ensure(undefined, signal)).rejects.toThrow("cancelled");
		expect(existsSync(join(f.root, "calls"))).toBe(false);
	});

	it.each(["wasmedge", "rustup", "rustc", "vendor", "build"])(
		"cancels %s without blocking the host and permits retry",
		async (phase) => {
			const f = fixture();
			f.block(phase);
			const runtime = f.runtime();
			const controller = new AbortController();
			const pending = runtime.ensure(undefined, controller.signal).catch((error: unknown) => error);
			await f.entered(phase);
			const pid = Number(readFileSync(join(f.root, `entered-${phase}`), "utf8"));
			controller.abort(new Error("cancelled"));
			expect(await pending).toEqual(new Error("cancelled"));
			expect(() => process.kill(pid, 0)).toThrow();
			expect(runtime.hasRunner).toBe(false);
			expect(readdirSync(f.template).some((name) => name.startsWith("vendor.tmp-"))).toBe(false);
			if (phase === "vendor") expect(existsSync(join(f.template, "vendor"))).toBe(false);
			f.unblock(phase);
			expect(await runtime.ensure()).toBeDefined();
		},
	);

	it.each(["tool", "skill"])(
		"cancels shared prewarm through the %s and retries after disposing a pending build",
		async (caller) => {
			const f = fixture();
			f.block("build");
			const runtime = f.runtime();
			runtime.prewarm();
			await f.entered("build");
			const controller = new AbortController();
			const tool = createRustTool(f.root, { provisioner: runtime });
			const pending = (
				caller === "tool"
					? tool.execute("cell", { code: "fn main() {}" }, controller.signal)
					: runtime.testSkill({ type: "rust", use: "agent_lib::skills::example" }, controller.signal)
			).catch((error: unknown) => error);
			const joined = runtime.ensure().catch((error: unknown) => error);
			controller.abort(new Error("tool cancelled"));
			expect(await pending).toBeInstanceOf(Error);
			expect(await joined).toEqual(new Error("tool cancelled"));
			rmSync(join(f.root, "entered-build"));
			const restarting = runtime.ensure().catch((error: unknown) => error);
			await f.entered("build");
			await runtime.dispose();
			expect(await restarting).toBeInstanceOf(Error);
			f.unblock("build");
			expect(await runtime.ensure()).toBeDefined();
		},
	);

	it("cancels and drains Git initialization before allowing a new runtime", async () => {
		const f = fixture();
		f.warm();
		const runtime = f.runtime();
		let release!: () => void;
		const draining = new Promise<void>((resolve) => {
			release = resolve;
		});
		let signal: AbortSignal | undefined;
		const ensure = vi.spyOn(WorkspaceHistory.prototype, "ensure").mockImplementationOnce(async (options) => {
			signal = options!.signal;
			await draining;
			signal!.throwIfAborted();
		});
		const starting = runtime.ensure().catch((error: unknown) => error);
		try {
			await vi.waitFor(() => expect(signal).toBeDefined(), { timeout: 5000 });
			let stopped = false;
			const stopping = runtime.dispose().then(() => {
				stopped = true;
			});
			expect(signal!.aborted).toBe(true);
			await Promise.resolve();
			expect(stopped).toBe(false);
			expect(runtime.hasRunner).toBe(false);
			release();
			expect(await starting).toBeInstanceOf(Error);
			await stopping;
			ensure.mockRestore();
			await runtime.ensure();
			expect(existsSync(join(f.workspace, ".git/HEAD"))).toBe(true);
		} finally {
			release();
			await starting;
		}
	});

	it("disposes during initial copying, waits for cleanup, and can provision again", async () => {
		const f = fixture();
		f.warm();
		const runtime = f.runtime();
		let release!: () => void;
		const draining = new Promise<void>((resolve) => {
			release = resolve;
		});
		const copy = workspaceFiles.copyWorkspacePath;
		let copying: ProvisioningContext | undefined;
		vi.spyOn(workspaceFiles, "copyWorkspacePath").mockImplementationOnce(async (...args) => {
			await copy(...args);
			copying = args[2];
			await draining;
			copying.check();
		});
		const starting = runtime.ensure().catch((error: unknown) => error);
		try {
			await vi.waitFor(() => expect(copying).toBeDefined(), { timeout: 5000 });
			let disposed = false;
			const stopping = runtime.dispose().then(() => {
				disposed = true;
			});
			expect(copying!.signal.aborted).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(disposed).toBe(false);
			expect(runtime.hasRunner).toBe(false);
			expect(existsSync(join(f.workspace, "Cargo.toml"))).toBe(false);
			release();
			expect(await starting).toBeInstanceOf(Error);
			await stopping;
			expect(existsSync(join(f.root, ".workspace.upgrade"))).toBe(false);
			await runtime.ensure();
			expect(runtime.hasRunner).toBe(true);
			expect(existsSync(join(f.workspace, ".git/HEAD"))).toBe(true);
		} finally {
			release();
			await starting;
		}
	});

	it("bounds a predecessor barrier without starting work after timeout", async () => {
		const f = fixture();
		let release!: () => void;
		const beforeStart = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = f.runtime({ beforeStart, provisionTimeoutMs: 50, cellTimeoutMs: 1 });
		try {
			await expect(runtime.ensure()).rejects.toThrow("provisioning timed out after 50 ms");
			expect(existsSync(join(f.root, "calls"))).toBe(false);
		} finally {
			release();
		}
		await runtime.dispose();
		expect(existsSync(join(f.root, "calls"))).toBe(false);
	});

	it("drains a timed-out subprocess", async () => {
		const f = fixture();
		const context = f.context(undefined, 200);
		const pending = context.exec({ bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, f.root);
		await expect(pending).rejects.toThrow("provisioning timed out after 200 ms");
	});

	it("serializes template preparation and cancels a waiter independently", async () => {
		const f = fixture();
		f.block("vendor");
		const owner = ensureTemplateReadyAsync(f.cargo, f.context());
		await f.entered("vendor");
		const controller = new AbortController();
		const waiter = ensureTemplateReadyAsync(f.cargo, f.context(controller)).catch((error: unknown) => error);
		const follower = ensureTemplateReadyAsync(f.cargo, f.context());
		controller.abort(new Error("waiter cancelled"));
		expect(await waiter).toEqual(new Error("waiter cancelled"));
		expect(readFileSync(join(f.root, "calls"), "utf8")).toBe("vendor\n");
		f.unblock("vendor");
		await Promise.all([owner, follower]);
		expect(readFileSync(join(f.root, "calls"), "utf8")).toBe("vendor\nbuild\n");
	});

	it("cancels template builds waiting for the shared Cargo permit", async () => {
		const f = fixture();
		mkdirSync(join(f.template, "vendor"));
		let release!: () => void;
		const held = withBuildPermit(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await vi.waitFor(() => expect(release).toBeDefined());
		const controller = new AbortController();
		const progress = vi.fn();
		const pending = ensureTemplateReadyAsync(f.cargo, f.context(controller), progress).catch(
			(error: unknown) => error,
		);
		try {
			await vi.waitFor(() => expect(progress).toHaveBeenCalled());
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(existsSync(join(f.root, "calls"))).toBe(false);
			controller.abort(new Error("queued build cancelled"));
			expect(await pending).toEqual(new Error("queued build cancelled"));
		} finally {
			release();
			await held;
		}
		expect(existsSync(join(f.root, "calls"))).toBe(false);
		await ensureTemplateReadyAsync(f.cargo, f.context());
		expect(readFileSync(join(f.root, "calls"), "utf8")).toBe("build\n");
	});

	it.each(["vendor", "build"])("keeps the original scaffold when its %s is cancelled", async (phase) => {
		const f = fixture();
		f.warm();
		const original = f.runtime();
		await original.ensure();
		await original.dispose();
		const marker = readFileSync(join(f.workspace, ".workspace-version"), "utf8");
		writeFileSync(join(f.workspace, "cell/src/main.rs"), "retained cell");
		writeFileSync(join(f.template, "rlm/src/lib.rs"), "new runtime");
		f.block(phase);
		const runtime = f.runtime(phase === "vendor" ? { preludeExtra: [{ name: "bytes", version: "1.10.1" }] } : {});
		const controller = new AbortController();
		const pending = runtime.ensure(undefined, controller.signal).catch((error: unknown) => error);
		await f.entered(phase);
		controller.abort(new Error("upgrade cancelled"));
		expect(String(await pending)).toMatch(/original workspace retained.*upgrade cancelled/);
		expect(readFileSync(join(f.workspace, ".workspace-version"), "utf8")).toBe(marker);
		expect(readFileSync(join(f.workspace, "cell/src/main.rs"), "utf8")).toBe("retained cell");
		expect(existsSync(join(f.root, ".workspace.upgrade"))).toBe(false);
		f.unblock(phase);
		await runtime.ensure();
		expect(readFileSync(join(f.workspace, "rlm/src/lib.rs"), "utf8")).toBe("new runtime");
	});

	it("does not unmount skills or cache partial probes on cancellation", async () => {
		const f = fixture();
		cpSync(f.template, f.workspace, { recursive: true });
		const skills = ["first", "second"].map((name) => {
			const cratePath = join(f.root, name);
			mkdirSync(join(cratePath, "src"), { recursive: true });
			const cargoTomlPath = join(cratePath, "Cargo.toml");
			writeFileSync(cargoTomlPath, `[package]\nname = "${name}"\nversion = "0.1.0"\n`);
			writeFileSync(join(cratePath, "src/lib.rs"), "pub fn example() {}\n");
			return { name, crateName: name, cratePath, cargoTomlPath };
		});
		writeFileSync(join(f.root, "fail-agent_lib"), "");
		writeFileSync(join(f.root, "fail-first"), "");
		f.block("second");
		const controller = new AbortController();
		const pending = syncRustSkillsAsync(f.workspace, skills, f.context(controller), { cargoBin: f.cargo }).catch(
			(error: unknown) => error,
		);
		await f.entered("second");
		controller.abort(new Error("probe cancelled"));
		expect(await pending).toEqual(new Error("probe cancelled"));
		expect(mountedSkillCrates(f.workspace)).toEqual(["first", "second"]);
		expect(existsSync(join(f.workspace, ".skills-hash"))).toBe(false);
		f.unblock("second");
		const result = await syncRustSkillsAsync(f.workspace, skills, f.context(), { cargoBin: f.cargo });
		expect(result.mounted).toEqual(["second"]);
		expect(result.failed).toEqual([{ name: "first", message: "bad skill" }]);
	});
});
