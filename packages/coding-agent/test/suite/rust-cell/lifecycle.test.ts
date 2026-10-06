import { afterEach, describe, expect, it, vi } from "vitest";
import type { RustCellProvisioner } from "../../../src/core/rust-cell/index.js";
import * as toolchain from "../../../src/core/rust-cell/toolchain.js";
import { createHarness, type Harness } from "../harness.js";

const harnesses: Harness[] = [];

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
	});

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
