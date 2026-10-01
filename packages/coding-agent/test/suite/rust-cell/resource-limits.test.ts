import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { isTemplateWarm, resolveToolchain } from "../../../src/core/rust-cell/toolchain.js";
import { createRustTool } from "../../../src/core/tools/rust.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("resource limits through AgentSession (faux provider)", () => {
	let harness: Harness | undefined;
	let sdkRoot: string | undefined;
	afterEach(async () => {
		await harness?.session.disposeAsync();
		harness?.cleanup();
		if (sdkRoot) rmSync(sdkRoot, { recursive: true, force: true });
	});

	it.each(["cellGasLimit", "cellMemoryPageLimit"] as const)(
		"applies %s from settings",
		{ timeout: 180_000 },
		async (name) => {
			harness = await createHarness({ persistSession: true, settings: { rustCell: { [name]: 1 } } });
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
});
