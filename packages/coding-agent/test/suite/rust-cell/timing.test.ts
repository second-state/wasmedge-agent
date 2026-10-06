import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CELL_PHASES } from "../../../src/core/rust-cell/cell-timing.js";
import { isTemplateWarm, resolveToolchain } from "../../../src/core/rust-cell/toolchain.js";
import type { CellResult } from "../../../src/core/rust-cell/types.js";
import { createHarness, type Harness } from "../harness.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}
let harness: Harness | undefined;
afterEach(async () => {
	await harness?.session.disposeAsync();
	harness?.cleanup();
	harness = undefined;
});

describe.skipIf(!available)("cell timing in session transcripts", () => {
	it("persists runner phases and provisioning on success and build failure", { timeout: 180_000 }, async () => {
		harness = await createHarness({ persistSession: true, isolateSessionStorage: true });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("rust", { code: 'fn main() { println!("timed"); }' }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("rust", { code: 'fn main() { let _: u32 = "broken"; }' }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Exercise cell timing");
		const messages = readFileSync(harness.sessionManager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const results: CellResult[] = messages
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "rust",
			)
			.map((entry) => entry.message.details);
		expect(results.map((result) => result.status)).toEqual(["ok", "compile_error"]);
		for (const result of results) {
			expect(result.timings?.version).toBe(1);
			expect(CELL_PHASES.reduce((sum, key) => sum + result.timings![key], 0)).toBeCloseTo(result.durationMs, 6);
			expect(result.timings!.cargoMs).toBeGreaterThan(0);
			expect(result.toolTiming!.totalMs).toBeGreaterThanOrEqual(
				result.toolTiming!.provisionMs + result.durationMs + result.timings!.queueMs,
			);
		}
		expect(results[0].timings!.snapshotMs).toBeGreaterThan(0);
		expect(results[1].timings).toMatchObject({ executionMs: 0, probeMs: 0, snapshotMs: 0 });
		expect(results[1].timings!.rollbackMs).toBeGreaterThan(0);
	});
});
