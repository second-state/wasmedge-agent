import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRlmRunHostHandler } from "../../../src/core/rlm-runtime.js";
import * as snapshots from "../../../src/core/rust-cell/workspace-snapshot.js";
import { createHarness, type Harness } from "../harness.js";

let harness: Harness | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await harness?.session.disposeAsync();
	harness?.cleanup();
	harness = undefined;
});

async function fixture() {
	const h = await createHarness({ persistSession: true, isolateSessionStorage: true });
	harness = h;
	const workspace = join(h.sessionManager.getSessionArtifactDir()!, "workspace");
	mkdirSync(join(workspace, "agent_lib/src"), { recursive: true });
	writeFileSync(join(workspace, "Cargo.toml"), "[workspace]\n");
	writeFileSync(join(workspace, "agent_lib/src/lib.rs"), "pub fn helper() {}\n");
	return h;
}

function holdSnapshot() {
	const copy = snapshots.snapshotWorkspace;
	let release!: () => void;
	const draining = new Promise<void>((resolve) => {
		release = resolve;
	});
	let active: { signal: AbortSignal; childDir: string } | undefined;
	const spy = vi.spyOn(snapshots, "snapshotWorkspace").mockImplementationOnce(async (source, destination, options) => {
		await copy(source, destination, options);
		active = { signal: options!.signal!, childDir: dirname(destination) };
		await draining;
		options!.signal!.throwIfAborted();
	});
	return {
		spy,
		release,
		entered: async () => {
			await vi.waitFor(() => expect(active).toBeDefined());
			return active!;
		},
	};
}

describe("child workspace preparation cancellation", () => {
	it("forwards the bridge signal, removes the child directory, and releases the reserved name", async () => {
		const h = await fixture();
		const held = holdSnapshot();
		const controller = new AbortController();
		const handler = createRlmRunHostHandler(async (request, context) => ({
			...(await h.session.runRlmChild(request.prompt, request.kwargs, request.cellSourceCode, context?.signal)),
		}));
		const pending = handler({ prompt: "prepare", kwargs: { name: "worker-a" } }, { signal: controller.signal }).catch(
			(error: unknown) => error,
		);
		try {
			const active = await held.entered();
			controller.abort(new Error("cell cancelled"));
			expect(active.signal.aborted).toBe(true);
			expect(h.eventsOfType("rlm_child_update")).toHaveLength(0);
			held.release();
			expect(await pending).toEqual(new Error("cell cancelled"));
			expect(existsSync(active.childDir)).toBe(false);
			h.setResponses([fauxAssistantMessage("child finished")]);
			const retryController = new AbortController();
			const retry = await h.session.runRlmChild("retry", { name: "worker-a" }, undefined, retryController.signal);
			retryController.abort(new Error("spawning cell finished"));
			expect(retry.name).toBe("worker-a");
			await vi.waitFor(async () =>
				expect((await h.session.listRlmSubagents()).subagents[0]?.status).toBe("completed"),
			);
		} finally {
			held.release();
			await pending;
		}
	});

	it.each(["async", "sync"])(
		"waits for snapshot cleanup after %s disposal without admitting a child",
		async (mode) => {
			const h = await fixture();
			const held = holdSnapshot();
			const pending = h.session.runRlmChild("prepare", { name: "worker-a" }).catch((error: unknown) => error);
			try {
				const active = await held.entered();
				if (mode === "sync") h.session.dispose();
				let disposed = false;
				const stopping = h.session.disposeAsync().then(() => {
					disposed = true;
				});
				await vi.waitFor(() => expect(active.signal.aborted).toBe(true));
				expect(disposed).toBe(false);
				held.release();
				expect(await pending).toBeInstanceOf(Error);
				await stopping;
				expect(existsSync(active.childDir)).toBe(false);
				expect(h.eventsOfType("rlm_child_update")).toHaveLength(0);
			} finally {
				held.release();
				await pending;
			}
		},
	);
});
