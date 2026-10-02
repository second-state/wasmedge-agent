import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTemplateWarm, resolveToolchain } from "../../../src/core/rust-cell/toolchain.js";
import { createRustTool } from "../../../src/core/tools/rust.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("curated dependencies through public entry points (faux provider)", () => {
	let harness: Harness | undefined;
	let root: string | undefined;
	afterEach(async () => {
		await harness?.session.disposeAsync();
		harness?.cleanup();
		vi.unstubAllEnvs();
		if (root) rmSync(root, { recursive: true, force: true });
	});
	it.each(["session", "SDK"])("adds and uses a curated crate via %s", { timeout: 180_000 }, async (entry) => {
		vi.stubEnv("CARGO_NET_OFFLINE", "true");
		root = mkdtempSync(join(tmpdir(), "deps-entry-"));
		harness = await createHarness({
			persistSession: true,
			isolateSessionStorage: true,
			settings: { rustCell: { cellTimeoutMs: 180_000 } },
			...(entry === "SDK" ? { tools: [createRustTool(root, { workspaceDir: join(root, "workspace") })] } : {}),
		});
		expect(harness.session.systemPrompt).toContain('rlm::deps::add("crate-name")');
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("rust", {
					code: 'use agent_lib::prelude::*; fn main() -> Result<()> { rlm::deps::add("itoa")?; Ok(()) }',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("rust", {
					code: 'use agent_lib::prelude::*; fn main() { println!("{}", extra::itoa::Buffer::new().format(123)); }',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Add and use the curated crate");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		for (const result of results) expect(result, getMessageText(result)).toMatchObject({ isError: false });
		const result = results[1];
		expect(result, getMessageText(result)).toMatchObject({ isError: false });
		expect(getMessageText(result)).toContain("123");
	});
});
