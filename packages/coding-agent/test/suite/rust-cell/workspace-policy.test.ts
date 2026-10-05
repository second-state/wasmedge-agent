import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe.skipIf(!available)("readonly workspace through AgentSession (faux provider)", () => {
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

	it("uses settings for guest rights and leaves host patch application available", { timeout: 180_000 }, async () => {
		const h = await createHarness({
			persistSession: true,
			isolateSessionStorage: true,
			settings: { rustCell: { workspaceWritePolicy: "ro" } },
		});
		harness = h;
		writeFileSync(join(h.tempDir, "note.txt"), "before\n");
		h.settingsManager.applyOverrides({ rustCell: { workspaceWritePolicy: "rw" } });
		h.session.setActiveToolsByName(["rust", "bash"]);
		expect(h.session.systemPrompt).toContain("Guest workspace policy: /workspace is read-only");
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("rust", {
					code: `fn main() {
    assert_eq!(std::fs::read_to_string("/workspace/note.txt").unwrap(), "before\\n");
    assert!(std::fs::write("/workspace/note.txt", "guest edit").is_err());
    println!("--- a/note.txt\\n+++ b/note.txt\\n@@ -1 +1 @@\\n-before\\n+after");
}`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("bash", {
					command: "git apply <<'PATCH'\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before\n+after\nPATCH",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("rust", {
					code: `fn main() {
    assert_eq!(std::fs::read_to_string("/workspace/note.txt").unwrap(), "after\\n");
    assert!(std::fs::write("/workspace/note.txt", "guest edit").is_err());
}`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("patch applied by host"),
		]);
		await h.session.prompt("Prepare a patch and apply it with the host tool");
		const results = h.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(3);
		for (const result of results) expect(result, getMessageText(result)).toMatchObject({ isError: false });
		expect(readFileSync(join(h.tempDir, "note.txt"), "utf-8")).toBe("after\n");
	});

	it.each([false, true])(
		"applies readonly to an SDK tool (shared provisioner: %s)",
		{ timeout: 180_000 },
		async (shared) => {
			sdkRoot = mkdtempSync(join(tmpdir(), "sdk-workspace-policy-"));
			const project = join(sdkRoot, "project");
			mkdirSync(project);
			writeFileSync(join(project, "note.txt"), "original");
			const options = {
				cwd: project,
				workspaceDir: join(sdkRoot, "session"),
				workspaceWritePolicy: "ro" as const,
			};
			if (shared) provisioner = new RustCellProvisioner(options);
			harness = await createHarness({
				tools: [createRustTool(project, shared ? { provisioner, workspaceWritePolicy: "rw" } : options)],
			});
			expect(harness.session.systemPrompt).toContain("Guest workspace policy: /workspace is read-only");
			expect(harness.session.systemPrompt).not.toContain('edit_exact("/workspace/src/a.rs"');
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("rust", {
						code: `fn main() {
    assert_eq!(std::fs::read_to_string("/workspace/note.txt").unwrap(), "original");
    assert!(std::fs::write("/workspace/note.txt", "guest edit").is_err());
}`,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("readonly"),
			]);
			await harness.session.prompt("Run the cell");
			const result = harness.session.messages.find((message) => message.role === "toolResult")!;
			expect(result, getMessageText(result)).toMatchObject({ isError: false, details: { status: "ok" } });
			expect(readFileSync(join(project, "note.txt"), "utf-8")).toBe("original");
		},
	);

	it("inherits readonly settings in child sessions", { timeout: 180_000 }, async () => {
		const h = await createHarness({
			persistSession: true,
			isolateSessionStorage: true,
			settings: { rustCell: { workspaceWritePolicy: "ro" } },
		});
		harness = h;
		writeFileSync(join(h.tempDir, "note.txt"), "original");
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("rust", {
					code: `fn main() {
    assert_eq!(std::fs::read_to_string("/workspace/note.txt").unwrap(), "original");
    assert!(std::fs::write("/workspace/note.txt", "child edit").is_err());
}`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("child finished"),
			fauxAssistantMessage("parent received completion"),
		]);
		const handle = await h.session.runRlmChild("Read the project");
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
		expect(child.systemPrompt).toContain("Guest workspace policy: /workspace is read-only");
		const result = child.messages.find((message) => message.role === "toolResult")!;
		expect(result, getMessageText(result)).toMatchObject({ isError: false, details: { status: "ok" } });
		expect(readFileSync(join(h.tempDir, "note.txt"), "utf-8")).toBe("original");
		await vi.waitFor(() => {
			expect(h.session.getLastAssistantText()).toBe("parent received completion");
			expect(h.session.isStreaming).toBe(false);
		});
	});
});
