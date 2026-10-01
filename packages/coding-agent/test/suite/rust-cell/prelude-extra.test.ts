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

describe.skipIf(!available)("preludeExtra through public entry points (faux provider)", () => {
	let harness: Harness | undefined;
	let root: string | undefined;
	afterEach(async () => {
		await harness?.session.disposeAsync();
		harness?.cleanup();
		vi.unstubAllEnvs();
		if (root) rmSync(root, { recursive: true, force: true });
	});
	it.each(["session", "SDK"])("uses configured crates via %s", { timeout: 180_000 }, async (entry) => {
		vi.stubEnv("CARGO_NET_OFFLINE", "true");
		const preludeExtra = [{ name: "itoa", version: "1.0.18" }];
		root = mkdtempSync(join(tmpdir(), "prelude-extra-entry-"));
		harness = await createHarness({
			persistSession: true,
			isolateSessionStorage: true,
			settings: { rustCell: { preludeExtra } },
			...(entry === "SDK"
				? { tools: [createRustTool(root, { workspaceDir: join(root, "workspace"), preludeExtra })] }
				: {}),
		});
		expect(harness.session.systemPrompt).toContain("User-configured crates under agent_lib::prelude::extra: itoa.");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("rust", {
					code: 'use agent_lib::prelude::*; fn main() { println!("{}", extra::itoa::Buffer::new().format(123)); }',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Use the configured crate");
		const result = harness.session.messages.find((message) => message.role === "toolResult")!;
		expect(result, getMessageText(result)).toMatchObject({ isError: false });
		expect(getMessageText(result)).toContain("123");
	});
});
