import { afterEach, describe, expect, it, vi } from "vitest";
import type { RustCellProvisioner } from "../../../src/core/rust-cell/index.js";
import * as toolchain from "../../../src/core/rust-cell/toolchain.js";
import { createHarness, type Harness } from "../harness.js";

const harnesses: Harness[] = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) {
		await harness.session.disposeAsync();
		harness.cleanup();
	}
});

function provisioner(harness: Harness): RustCellProvisioner {
	return (harness.session as unknown as { _rustCellProvisioner: RustCellProvisioner })._rustCellProvisioner;
}

describe("session runtime lifecycle", () => {
	it.each(["sync", "async"])("starts runtime shutdown through %s session disposal", async (mode) => {
		const harness = await createHarness();
		harnesses.push(harness);
		let finish!: () => void;
		const stopped = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const dispose = vi.spyOn(provisioner(harness), "dispose").mockReturnValue(stopped);
		let finished = false;
		const cleanup = (mode === "async" ? harness.session.disposeAsync() : Promise.resolve()).then(() => {
			finished = true;
		});
		if (mode === "sync") harness.session.dispose();
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(dispose).toHaveBeenCalled();
			if (mode === "async") expect(finished).toBe(false);
		} finally {
			finish();
			await cleanup;
		}
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it.each(["runtime", "callback"])("waits for sync disposal when %s cleanup finishes first", async (first) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const runtime = deferred();
		const callback = deferred();
		const dispose = vi.spyOn(provisioner(harness), "dispose").mockReturnValue(runtime.promise);
		harness.session.registerDisposeCallback(() => callback.promise);
		harness.session.dispose();
		let finished = false;
		const cleanup = harness.session.disposeAsync().then(() => {
			finished = true;
		});
		const concurrent = harness.session.disposeAsync();
		try {
			(first === "runtime" ? runtime : callback).resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(finished).toBe(false);
			(first === "runtime" ? callback : runtime).resolve();
			await Promise.all([cleanup, concurrent]);
			await harness.session.disposeAsync();
			expect(dispose).toHaveBeenCalledTimes(1);
		} finally {
			runtime.resolve();
			callback.resolve();
			await Promise.all([cleanup, concurrent]);
		}
	});

	it("waits for runtime cleanup if sync disposal interrupts the async refinement drain", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const refinement = deferred();
		const runtime = deferred();
		const internals = harness.session as unknown as { _drainPendingRefinementForDisposal(): Promise<void> };
		vi.spyOn(internals, "_drainPendingRefinementForDisposal").mockReturnValue(refinement.promise);
		const dispose = vi.spyOn(provisioner(harness), "dispose").mockReturnValue(runtime.promise);
		let finished = false;
		const cleanup = harness.session.disposeAsync().then(() => {
			finished = true;
		});
		harness.session.dispose();
		try {
			refinement.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(finished).toBe(false);
			runtime.resolve();
			await cleanup;
			expect(dispose).toHaveBeenCalledTimes(1);
		} finally {
			refinement.resolve();
			runtime.resolve();
			await cleanup;
		}
	});

	it.each(["sync", "async"])(
		"still runs disposal callbacks after runtime cleanup fails in %s disposal",
		async (mode) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const dispose = vi.spyOn(provisioner(harness), "dispose").mockRejectedValue(new Error("cleanup failed"));
			const callback = vi.fn(async () => {});
			harness.session.registerDisposeCallback(callback);
			if (mode === "sync") harness.session.dispose();
			await harness.session.disposeAsync();
			await harness.session.disposeAsync();
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledTimes(1);
		},
	);

	it("holds the replacement runtime until the previous runtime finishes shutdown", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const previous = provisioner(harness);
		let finish!: () => void;
		const stopped = new Promise<void>((resolve) => {
			finish = resolve;
		});
		vi.spyOn(previous, "dispose").mockReturnValue(stopped);
		const resolveToolchain = vi.spyOn(toolchain, "resolveToolchain").mockImplementation(() => {
			throw new Error("startup reached");
		});
		try {
			await harness.session.reload();
			const next = provisioner(harness);
			expect(next).not.toBe(previous);
			const starting = next.ensure().catch((error: unknown) => error);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(resolveToolchain).not.toHaveBeenCalled();
			finish();
			expect(await starting).toEqual(new Error("startup reached"));
			expect(resolveToolchain).toHaveBeenCalledTimes(1);
		} finally {
			finish();
		}
	});
});
