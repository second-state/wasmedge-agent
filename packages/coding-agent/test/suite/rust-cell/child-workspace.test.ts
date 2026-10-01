import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTemplateWarm, resolveToolchain } from "../../../src/core/rust-cell/toolchain.js";
import { WORKSPACE_SEED_DIR } from "../../../src/core/rust-cell/workspace-snapshot.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("spawn-time library inheritance (real cells, faux provider)", () => {
	let harness: Harness | undefined;
	let reloadedFaux: FauxProviderRegistration | undefined;
	afterEach(async () => {
		await harness?.session.disposeAsync();
		harness?.cleanup();
		reloadedFaux?.unregister();
		reloadedFaux = undefined;
	});

	it(
		"freezes the parent library before the child's first cell and preserves child edits on reload",
		{ timeout: 300_000 },
		async () => {
			const h = await createHarness({ persistSession: true, isolateSessionStorage: true });
			harness = h;
			const helper = (value: number) => `pub fn answer() -> u32 { ${value} }\n`;
			h.setResponses([
				fauxAssistantMessage(
					fauxToolCall("rust", {
						code: 'use agent_lib::prelude::*; fn main() { rlm::state::set("parent_only", &true).unwrap(); }',
						lib: [{ path: "src/helpers/shared.rs", content: helper(42) }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("prepared"),
			]);
			await h.session.prompt("prepare a helper");
			expect(h.session.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
				isError: false,
			});
			const parentWs = join(h.sessionManager.getSessionArtifactDir()!, "workspace");
			const parentHelper = join(parentWs, "agent_lib/src/helpers/shared.rs");
			expect(readFileSync(parentHelper, "utf-8")).toBe(helper(42));

			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			h.setResponses([
				async () => {
					await gate;
					return fauxAssistantMessage(
						fauxToolCall("rust", {
							code: 'use agent_lib::prelude::*; fn main() { assert!(rlm::state::get::<bool>("parent_only").unwrap().is_none()); println!("answer={}", agent_lib::helpers::shared::answer()); }',
						}),
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage("child finished"),
				fauxAssistantMessage("parent received completion"),
			]);
			try {
				const handle = await h.session.runRlmChild("use the shared helper");
				const seed = join(handle.session_dir, WORKSPACE_SEED_DIR);
				expect(readFileSync(join(seed, "agent_lib/src/helpers/shared.rs"), "utf-8")).toBe(helper(42));
				expect(existsSync(join(seed, "state"))).toBe(false);
				writeFileSync(parentHelper, helper(77));
				release();
				await vi.waitFor(
					() => {
						expect(
							h
								.eventsOfType("rlm_child_update")
								.some((event) => event.child.id === handle.rlm_child_id && event.child.status === "done"),
						).toBe(true);
						expect(h.session.getRlmChildRunStatus(handle.rlm_child_id)).toBeUndefined();
					},
					{ timeout: 120_000 },
				);
				const child = h.session.getRlmChildSession(handle.rlm_child_id)!;
				const result = child.messages.filter((message) => message.role === "toolResult").at(-1)!;
				expect(getMessageText(result)).toContain("answer=42");
				await vi.waitFor(() => {
					expect(h.session.getLastAssistantText()).toBe("parent received completion");
					expect(h.session.isStreaming).toBe(false);
				});
				const childWs = join(child.sessionManager.getSessionArtifactDir()!, "workspace");
				writeFileSync(join(childWs, "agent_lib/src/helpers/shared.rs"), helper(99));
				await child.reload();
				// Reload resets the provider registry, including the harness's faux API.
				reloadedFaux = registerFauxProvider({ api: h.faux.api });
				reloadedFaux.setResponses([
					fauxAssistantMessage(
						fauxToolCall("rust", {
							code: 'fn main() { println!("answer={}", agent_lib::helpers::shared::answer()); }',
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("reloaded"),
				]);
				await child.prompt("use the child edit after reload");
				expect(child.getLastAssistantText(), JSON.stringify(child.messages.slice(-3))).toBe("reloaded");
				expect(getMessageText(child.messages.filter((message) => message.role === "toolResult").at(-1)!)).toContain(
					"answer=99",
				);
				expect(readFileSync(parentHelper, "utf-8")).toBe(helper(77));
			} finally {
				release();
			}
		},
	);
});
