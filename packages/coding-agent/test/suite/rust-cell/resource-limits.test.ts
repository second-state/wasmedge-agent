import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessResourceGroup } from "../../../src/core/rust-cell/process-group.js";
import { isTemplateWarm, resolveToolchain } from "../../../src/core/rust-cell/toolchain.js";
import { createRustTool } from "../../../src/core/tools/rust.js";
import { hasProcessLimits } from "../../fixtures/process-limits.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("resource limits through AgentSession (faux provider)", () => {
	let harness: Harness | undefined;
	let sdkRoot: string | undefined;
	let group: ProcessResourceGroup | undefined;
	afterEach(async () => {
		await harness?.session.disposeAsync();
		harness?.cleanup();
		group?.dispose();
		group = undefined;
		if (sdkRoot) rmSync(sdkRoot, { recursive: true, force: true });
	});

	it.each(["cellGasLimit", "cellMemoryPageLimit"] as const)(
		"applies %s from settings",
		{ timeout: 180_000 },
		async (name) => {
			harness = await createHarness({
				persistSession: true,
				isolateSessionStorage: true,
				settings: { rustCell: { [name]: 1 } },
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("rust", { code: 'fn main() { println!("should not run"); }' }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("limit reached"),
			]);
			await harness.session.prompt("Run the cell");
			const result = harness.session.messages.find((message) => message.role === "toolResult")!;
			expect(result, getMessageText(result)).toMatchObject({ details: { status: "error", exitCode: 1 } });
			expect(getMessageText(result)).not.toContain("should not run");
			if (name === "cellGasLimit") expect(getMessageText(result)).toMatch(/cost (?:exceeded limit|limit exceeded)/i);
		},
	);

	it("applies limits to a standalone SDK rust tool", { timeout: 180_000 }, async () => {
		sdkRoot = mkdtempSync(join(tmpdir(), "sdk-cell-limit-"));
		harness = await createHarness({
			tools: [createRustTool(sdkRoot, { workspaceDir: join(sdkRoot, "workspace"), cellGasLimit: 1 })],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("rust", { code: "fn main() {}" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("limit reached"),
		]);
		await harness.session.prompt("Run the cell");
		const result = harness.session.messages.find((message) => message.role === "toolResult")!;
		expect(result).toMatchObject({ details: { status: "error", exitCode: 1 } });
		expect(getMessageText(result)).toMatch(/cost (?:exceeded limit|limit exceeded)/i);
	});

	it.skipIf(!hasProcessLimits()).each(["session", "SDK", "tree session", "tree SDK"])(
		"enforces process memory from %s options without disabling the bridge",
		{ timeout: 240_000 },
		async (mode) => {
			const limits = { memoryMaxMb: 1024, tasksMax: 256 };
			const tree = mode.startsWith("tree");
			if (mode === "tree SDK") group = new ProcessResourceGroup(limits);
			const rustCell = {
				cargoSandbox: "bubblewrap" as const,
				...(tree ? { treeProcessLimits: limits } : { processLimits: limits }),
			};
			sdkRoot = mkdtempSync(join(tmpdir(), "sdk-process-limit-"));
			harness = await createHarness(
				mode.endsWith("session")
					? { persistSession: true, isolateSessionStorage: true, settings: { rustCell } }
					: {
							tools: [
								createRustTool(sdkRoot, {
									...rustCell,
									processGroup: group,
									workspaceDir: join(sdkRoot, "workspace"),
								}),
							],
						},
			);
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("rust", {
						code: 'use agent_lib::prelude::rlm; fn main() { let error = rlm::api::list("agent_lib").unwrap_err(); assert!(error.to_string().contains("API introspection is disabled")); println!("bridge works"); }',
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("rust", {
						code: 'fn main() { let data = vec![42u8; 1536 * 1024 * 1024]; std::hint::black_box(data); println!("over budget"); }',
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("limit reached"),
			]);
			await harness.session.prompt("Run the cells");
			const results = harness.session.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(2);
			expect(results[0], getMessageText(results[0])).toMatchObject({ details: { status: "ok" } });
			expect(getMessageText(results[0])).toContain("bridge works");
			expect(results[1], getMessageText(results[1])).toMatchObject({ details: { status: "error" } });
			expect(getMessageText(results[1])).not.toContain("over budget");
		},
	);
});
