import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProvisioningContext } from "../src/core/rust-cell/provisioning.js";
import { acquireTemplateLock, acquireTemplateLockSync } from "../src/core/rust-cell/template-lock.js";

const worker = fileURLToPath(new URL("./fixtures/template-preparation-worker.ts", import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];
const contexts: ProvisioningContext[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const child of children.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		const closed = once(child, "close");
		child.kill("SIGKILL");
		await closed;
	}
	for (const context of contexts.splice(0)) context.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(timeout = 5000, signal = new AbortController().signal) {
	const result = new ProvisioningContext(signal, timeout);
	contexts.push(result);
	return result;
}

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "template-lock-")));
	roots.push(root);
	const template = join(root, "template");
	mkdirSync(template);
	writeFileSync(join(template, "Cargo.toml"), "[workspace]\n");
	const owner = `${template}.prepare-owner`;
	const cargo = join(root, "cargo");
	writeFileSync(
		cargo,
		`#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const root = ${JSON.stringify(root)}, phase = process.argv[2];
fs.appendFileSync(path.join(root, "calls"), phase + "\\n");
function finish() {
 if (fs.existsSync(path.join(root, "fail-" + phase))) process.exitCode = 1;
 else if (phase === "vendor") fs.mkdirSync(process.argv.at(-1), {recursive: true});
 else {
  const target = path.join(process.cwd(), "target/wasm32-wasip1/release");
  fs.mkdirSync(target, {recursive: true}); fs.writeFileSync(path.join(target, "cell.wasm"), "test");
 }
}
if (fs.existsSync(path.join(root, "block-" + phase))) {
 const timer = setInterval(() => {
  if (!fs.existsSync(path.join(root, "block-" + phase))) { clearInterval(timer); finish(); }
 }, 10);
} else finish();
`,
		{ mode: 0o755 },
	);
	const calls = () => (existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8") : "");
	const start = (mode = "async", path = template, timeout = 10_000) => {
		const child = fork(worker, [path, cargo, mode, String(timeout)], {
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.push(child);
		const messages: { event: string; error?: string }[] = [];
		let stderr = "";
		child.stderr!.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("message", (message: { event: string; error?: string }) => messages.push(message));
		const closed = once(child, "close");
		return {
			child,
			messages,
			closed,
			event: async (event: string) => {
				await vi.waitFor(
					() =>
						expect(
							messages.some((message) => message.event === event),
							stderr,
						).toBe(true),
					{ timeout: 10_000, interval: 10 },
				);
			},
		};
	};
	return { root, template, owner, calls, start };
}

describe("template preparation ownership", () => {
	it("recovers an abandoned metadata guard", async () => {
		const f = fixture();
		mkdirSync(`${f.owner}.guard`);
		utimesSync(`${f.owner}.guard`, new Date(0), new Date(0));
		const release = await acquireTemplateLock(f.template, context());
		release();
		expect(existsSync(`${f.owner}.guard`)).toBe(false);
		expect(existsSync(f.owner)).toBe(false);
	});

	it("bounds waiting by the startup deadline and preserves a live owner even with old metadata", async () => {
		const f = fixture();
		const owner = { version: 1, pid: process.pid, hostname: hostname(), token: "live" };
		writeFileSync(f.owner, JSON.stringify(owner));
		utimesSync(f.owner, new Date(0), new Date(0));
		await expect(acquireTemplateLock(f.template, context(100))).rejects.toThrow("provisioning timed out");
		expect(JSON.parse(readFileSync(f.owner, "utf8"))).toEqual(owner);
	});

	it.each(["foreign", "malformed", "permission"])("does not reclaim an uncertain %s owner", async (kind) => {
		const f = fixture();
		const owner = {
			version: 1,
			pid: process.pid,
			hostname: kind === "foreign" ? `${hostname()}-other` : hostname(),
			token: "retained",
		};
		const raw = kind === "malformed" ? "{}" : JSON.stringify(owner);
		writeFileSync(f.owner, raw);
		if (kind === "permission")
			vi.spyOn(process, "kill").mockImplementation(() => {
				throw Object.assign(new Error("denied"), { code: "EPERM" });
			});
		await expect(acquireTemplateLock(f.template, context(100))).rejects.toThrow();
		expect(readFileSync(f.owner, "utf8")).toBe(raw);
	});

	it("rejects sync reentrancy and does not release a later acquisition", async () => {
		const f = fixture();
		const first = await acquireTemplateLock(f.template, context());
		expect(() => acquireTemplateLockSync(f.template)).toThrow("already active in this process");
		first();
		const second = acquireTemplateLockSync(f.template);
		try {
			first();
			expect(existsSync(f.owner)).toBe(true);
		} finally {
			second();
		}
		expect(existsSync(f.owner)).toBe(false);
	});

	it("does not acquire for a pre-cancelled caller", async () => {
		const f = fixture();
		await expect(
			acquireTemplateLock(f.template, context(5000, AbortSignal.abort(new Error("cancelled")))),
		).rejects.toThrow("cancelled");
		expect(existsSync(f.owner)).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("template preparation across processes", () => {
	it("uses a ready template without writing to its read-only parent", async () => {
		const f = fixture();
		mkdirSync(join(f.template, "vendor"));
		const target = join(f.template, "target/wasm32-wasip1/release");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "cell.wasm"), "test");
		chmodSync(f.root, 0o555);
		try {
			await Promise.all([f.start().event("done"), f.start("sync").event("done")]);
			expect(f.calls()).toBe("");
			expect(existsSync(f.owner)).toBe(false);
		} finally {
			chmodSync(f.root, 0o755);
		}
	});

	it("waits for an active preparation even when cache files are already visible", async () => {
		const f = fixture();
		mkdirSync(join(f.template, "vendor"));
		const target = join(f.template, "target/wasm32-wasip1/release");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "cell.wasm"), "test");
		const owner = f.start("hold");
		await owner.event("held");
		const waiter = f.start("async", f.template, 100);
		await waiter.event("failed");
		expect(waiter.messages.at(-1)?.error).toContain("provisioning timed out");
		owner.child.send("release");
		await owner.event("done");
	});

	it("prepares once across async, sync and symlink callers", async () => {
		const f = fixture();
		const alias = join(f.root, "alias");
		symlinkSync(f.template, alias);
		writeFileSync(join(f.root, "block-vendor"), "");
		const owner = f.start();
		await vi.waitFor(() => expect(f.calls()).toBe("vendor\n"), { timeout: 10_000, interval: 10 });
		const aliasWaiter = f.start("async", alias);
		const syncWaiter = f.start("sync");
		await Promise.all([aliasWaiter.event("started"), syncWaiter.event("started")]);
		await delay(150);
		expect(f.calls()).toBe("vendor\n");
		rmSync(join(f.root, "block-vendor"));
		await Promise.all([owner.event("done"), aliasWaiter.event("done"), syncWaiter.event("done")]);
		expect(f.calls()).toBe("vendor\nbuild\n");
		expect(existsSync(f.owner)).toBe(false);
	});

	it("cancels and times out independent waiters without cancelling the owner", async () => {
		const f = fixture();
		const owner = f.start("hold");
		await owner.event("held");
		const original = readFileSync(f.owner, "utf8");
		const cancelled = f.start();
		const timedOut = f.start("async", f.template, 100);
		await cancelled.event("started");
		cancelled.child.send("cancel");
		await Promise.all([cancelled.event("failed"), timedOut.event("failed")]);
		expect(cancelled.messages.at(-1)?.error).toBe("waiter cancelled");
		expect(timedOut.messages.at(-1)?.error).toContain("provisioning timed out");
		expect(readFileSync(f.owner, "utf8")).toBe(original);
		expect(f.calls()).toBe("");
		owner.child.send("release");
		await owner.event("done");
		await f.start().event("done");
		expect(f.calls()).toBe("vendor\nbuild\n");
	});

	it("recovers after SIGKILL with two competing successors", async () => {
		const f = fixture();
		const owner = f.start("hold");
		await owner.event("held");
		owner.child.kill("SIGKILL");
		await owner.closed;
		expect(existsSync(f.owner)).toBe(true);
		await Promise.all([f.start().event("done"), f.start("sync").event("done")]);
		expect(f.calls()).toBe("vendor\nbuild\n");
		expect(existsSync(f.owner)).toBe(false);
	});

	it.each([
		["async", "vendor"],
		["sync", "vendor"],
		["async", "build"],
		["sync", "build"],
	])("releases ownership after a %s %s failure", async (mode, phase) => {
		const f = fixture();
		writeFileSync(join(f.root, `fail-${phase}`), "");
		await f.start(mode).event("failed");
		expect(existsSync(f.owner)).toBe(false);
		expect(existsSync(join(f.template, "vendor"))).toBe(phase === "build");
		rmSync(join(f.root, `fail-${phase}`));
		await f.start().event("done");
		expect(f.calls()).toBe(phase === "vendor" ? "vendor\nvendor\nbuild\n" : "vendor\nbuild\nbuild\n");
	});

	it("allows a waiting process to prepare after the active vendor is cancelled", async () => {
		const f = fixture();
		writeFileSync(join(f.root, "block-vendor"), "");
		const owner = f.start();
		await vi.waitFor(() => expect(f.calls()).toBe("vendor\n"), { timeout: 10_000, interval: 10 });
		const waiter = f.start();
		await waiter.event("started");
		owner.child.send("cancel");
		await owner.event("failed");
		await vi.waitFor(() => expect(f.calls()).toBe("vendor\nvendor\n"), { timeout: 10_000, interval: 10 });
		rmSync(join(f.root, "block-vendor"));
		await waiter.event("done");
		expect(f.calls()).toBe("vendor\nvendor\nbuild\n");
		expect(existsSync(f.owner)).toBe(false);
	});

	it.each(["vendor", "warm"])("coordinates the direct %s maintenance API", async (mode) => {
		const f = fixture();
		const owner = f.start("hold");
		await owner.event("held");
		const waiting = f.start(mode);
		await waiting.event("started");
		await delay(150);
		expect(f.calls()).toBe("");
		owner.child.send("release");
		await waiting.event("done");
		expect(f.calls()).toBe(mode === "vendor" ? "vendor\n" : "build\n");
	});
});
