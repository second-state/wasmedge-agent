import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustCellProvisioner } from "../../../src/core/rust-cell/index.js";
import { isTemplateWarm, resolveToolchain } from "../../../src/core/rust-cell/toolchain.js";
import { createRustTool } from "../../../src/core/tools/rust.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

const request = {
	code: 'fn main() { println!("{}", agent_lib::helpers::library_gate::value()); }',
	lib: [{ path: "src/helpers/library_gate.rs", content: "pub fn value() -> u32 { 42 }" }],
};

describe.skipIf(!available)("library test gate through AgentSession (faux provider)", () => {
	let harness: Harness | undefined;
	let sdkRoot: string | undefined;
	let provisioner: RustCellProvisioner | undefined;
	afterEach(async () => {
		await harness?.session.disposeAsync();
		harness?.cleanup();
		await provisioner?.dispose();
		if (sdkRoot) rmSync(sdkRoot, { recursive: true, force: true });
		harness = undefined;
		sdkRoot = undefined;
		provisioner = undefined;
	});

	it.each(["settings", "SDK", "shared SDK"])(
		"enforces the gate via %s and lets the model repair missing tests",
		{ timeout: 180_000 },
		async (mode) => {
			if (mode === "settings") {
				harness = await createHarness({
					persistSession: true,
					isolateSessionStorage: true,
					settings: { rustCell: { libraryTestGate: true } },
				});
				harness.settingsManager.applyOverrides({ rustCell: { libraryTestGate: false } });
			} else {
				sdkRoot = mkdtempSync(join(tmpdir(), "sdk-library-tests-"));
				const cwd = join(sdkRoot, "project");
				mkdirSync(cwd);
				const options = { cwd, workspaceDir: join(sdkRoot, "workspace"), libraryTestGate: true };
				if (mode === "shared SDK") provisioner = new RustCellProvisioner(options);
				harness = await createHarness({
					tools: [createRustTool(cwd, provisioner ? { provisioner, libraryTestGate: false } : options)],
				});
			}
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("rust", request), { stopReason: "toolUse" }),
				fauxAssistantMessage(
					fauxToolCall("rust", {
						...request,
						lib: [
							{
								...request.lib[0],
								content: `${request.lib[0].content}\n#[test] fn answer() { assert_eq!(value(), 42); }`,
							},
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("library validated"),
			]);
			await harness.session.prompt("Add a tested helper");
			const results = harness.session.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(2);
			expect(results[0]).toMatchObject({ details: { status: "error", libApplied: false, runMs: 0 } });
			expect(getMessageText(results[0]!)).toContain("at least one passing");
			expect(results[1], getMessageText(results[1]!)).toMatchObject({
				isError: false,
				details: { status: "ok", libApplied: true },
			});
			if (mode === "settings") {
				await harness.session.reload();
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("rust", request), { stopReason: "toolUse" }),
					fauxAssistantMessage("gate disabled on reload"),
				]);
				await harness.session.prompt("Use the updated settings");
				const latest = harness.session.messages.filter((message) => message.role === "toolResult").at(-1)!;
				expect(latest, getMessageText(latest)).toMatchObject({ isError: false, details: { status: "ok" } });
			}
		},
	);

	it("inherits the gate in child sessions", { timeout: 180_000 }, async () => {
		harness = await createHarness({
			persistSession: true,
			isolateSessionStorage: true,
			settings: { rustCell: { libraryTestGate: true } },
		});
		const h = harness;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("rust", request), { stopReason: "toolUse" }),
			fauxAssistantMessage("child observed missing tests"),
			fauxAssistantMessage("parent received completion"),
		]);
		const handle = await h.session.runRlmChild("Add a helper");
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
		const result = child.messages.find((message) => message.role === "toolResult")!;
		expect(result).toMatchObject({ details: { status: "error", libApplied: false } });
		expect(getMessageText(result)).toContain("at least one passing");
		await vi.waitFor(() => {
			expect(h.session.getLastAssistantText()).toBe("parent received completion");
			expect(h.session.isStreaming).toBe(false);
		});
	});
});
