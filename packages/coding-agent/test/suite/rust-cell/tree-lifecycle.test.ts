import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProcess } from "../../../src/core/rust-cell/process.js";
import { hasProcessLimits } from "../../fixtures/process-limits.js";
import { createHarness, type Harness } from "../harness.js";

describe.skipIf(!hasProcessLimits())("live agent tree resource ownership", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.session.disposeAsync();
		harness?.cleanup();
	});

	it("shares a fixed budget with inline children through reload and child disposal", async () => {
		const h = await createHarness({
			persistSession: true,
			isolateSessionStorage: true,
			settings: { rustCell: { cargoSandbox: "bubblewrap", treeProcessLimits: { tasksMax: 64 } } },
		});
		harness = h;
		const group = h.session.rustProcessGroup!;
		expect(group.limits).toEqual({ tasksMax: 64 });
		h.setResponses([fauxAssistantMessage("child done"), fauxAssistantMessage("parent done")]);
		const handle = await h.session.runRlmChild("finish without tools");
		await vi.waitFor(() => {
			expect(h.session.getRlmChildSession(handle.rlm_child_id)).toBeDefined();
			expect(h.session.isStreaming).toBe(false);
			expect(h.session.getRlmChildRunStatus(handle.rlm_child_id)).toBeUndefined();
		});
		const child = h.session.getRlmChildSession(handle.rlm_child_id)!;
		expect(child.rustProcessGroup).toBe(group);
		await child.reload();
		expect(child.rustProcessGroup).toBe(group);
		await child.disposeAsync();
		await h.session.reload();
		expect(h.session.rustProcessGroup).toBe(group);
		const result = await runProcess("/bin/cat", ["/proc/self/cgroup"], {
			cwd: h.tempDir,
			timeoutMs: 10_000,
			processGroup: group,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(group.unit);
		await h.session.disposeAsync();
		expect(() => group.retain()).toThrow("disposed");
	});
});
