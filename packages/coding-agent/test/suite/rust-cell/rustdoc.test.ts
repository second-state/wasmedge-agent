import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustCellProvisioner } from "../../../src/core/rust-cell/index.js";
import * as cellProcess from "../../../src/core/rust-cell/process.js";
import { RUSTDOC_CACHE_PATH } from "../../../src/core/rust-cell/rustdoc-cache.js";
import { RUSTDOC_TEST_TOOLCHAIN } from "../../../src/core/rust-cell/rustdoc-index.js";
import { isTemplateWarm, resolveToolchain } from "../../../src/core/rust-cell/toolchain.js";
import { createRustTool } from "../../../src/core/tools/rust.js";
import { hasRustdocToolchain } from "../../fixtures/rustdoc.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm() && hasRustdocToolchain();
} catch {}

const query = `use agent_lib::prelude::*;
fn main() -> Result<()> {
    let api = rlm::api::describe("agent_lib::helpers::docs::Entry::get")?;
    assert_eq!(api["source"], "rustdoc-json");
    assert_eq!(api["items"][0]["declaration"]["function"]["sig"]["output"]["primitive"], "u32");
    let listed = rlm::api::list("agent_lib::helpers::docs")?;
    assert!(listed["total"].as_u64().unwrap() > 1);
    assert!(rlm::api::list_page("agent_lib::helpers::docs", 1000)?["items"].as_array().unwrap().is_empty());
    println!("documented method returns u32");
    Ok(())
}`;
const request = {
	code: query,
	lib: [{ path: "src/helpers/docs.rs", content: "pub struct Entry; impl Entry { pub fn get(&self) -> u32 { 42 } }" }],
};

describe.skipIf(!available)("rustdoc introspection through AgentSession", () => {
	let harness: Harness | undefined;
	let provisioner: RustCellProvisioner | undefined;
	let sdkRoot: string | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.session.disposeAsync();
		harness?.cleanup();
		await provisioner?.dispose();
		if (sdkRoot) rmSync(sdkRoot, { recursive: true, force: true });
		harness = undefined;
		provisioner = undefined;
		sdkRoot = undefined;
	});

	it.each(["settings", "SDK", "shared SDK"])(
		"queries WASI API declarations via %s",
		{ timeout: 240_000 },
		async (mode) => {
			if (mode === "settings") {
				harness = await createHarness({
					persistSession: true,
					isolateSessionStorage: true,
					settings: { rustCell: { rustdocToolchain: RUSTDOC_TEST_TOOLCHAIN } },
				});
				harness.settingsManager.applyOverrides({ rustCell: { rustdocToolchain: null } });
			} else {
				sdkRoot = mkdtempSync(join(tmpdir(), "sdk-rustdoc-"));
				const cwd = join(sdkRoot, "project");
				mkdirSync(cwd);
				const options = { cwd, workspaceDir: join(sdkRoot, "workspace"), rustdocToolchain: RUSTDOC_TEST_TOOLCHAIN };
				if (mode === "shared SDK") provisioner = new RustCellProvisioner(options);
				harness = await createHarness({
					tools: [createRustTool(cwd, provisioner ? { provisioner, rustdocToolchain: null } : options)],
				});
			}
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("rust", request), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("rust", { code: query }), { stopReason: "toolUse" }),
				fauxAssistantMessage("reused the public API"),
			]);
			await harness.session.prompt("Inspect the new helper method");
			const results = harness.session.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(2);
			for (const result of results) {
				expect(result, getMessageText(result)).toMatchObject({ details: { status: "ok" } });
				expect(getMessageText(result)).toContain("documented method returns u32");
			}
			if (mode === "settings") {
				await harness.session.reload();
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("rust", {
							code: 'fn main() { assert!(agent_lib::prelude::rlm::api::list("agent_lib").is_err()); println!("disabled after reload"); }',
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("updated settings applied"),
				]);
				await harness.session.prompt("Check the updated policy");
				const result = harness.session.messages.filter((message) => message.role === "toolResult").at(-1)!;
				expect(result, getMessageText(result)).toMatchObject({ details: { status: "ok" } });
			}
		},
	);

	it("waits for active rustdoc cancellation and snapshot cleanup on disposal", { timeout: 240_000 }, async () => {
		sdkRoot = mkdtempSync(join(tmpdir(), "sdk-rustdoc-dispose-"));
		const cwd = join(sdkRoot, "project");
		mkdirSync(cwd);
		const workspaceDir = join(sdkRoot, "workspace");
		provisioner = new RustCellProvisioner({ cwd, workspaceDir, rustdocToolchain: RUSTDOC_TEST_TOOLCHAIN });
		const runner = await provisioner.ensure();
		let startDocs: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			startDocs = resolve;
		});
		const original = cellProcess.runProcess;
		let snapshot = "";
		vi.spyOn(cellProcess, "runProcess").mockImplementation((bin, args, options) => {
			if (!args.includes("doc")) return original(bin, args, options);
			snapshot = options.cwd;
			const running = original(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
			startDocs();
			return running;
		});
		const result = runner.execute({
			code: 'use agent_lib::prelude::*; fn main() -> Result<()> { rlm::api::list("rlm")?; Ok(()) }',
		});
		await entered;
		await provisioner.dispose();
		expect(await result).toMatchObject({ status: "aborted" });
		expect(existsSync(snapshot)).toBe(false);
		expect(existsSync(join(workspaceDir, RUSTDOC_CACHE_PATH))).toBe(false);
	});

	it("inherits the configured toolchain in child sessions", { timeout: 240_000 }, async () => {
		harness = await createHarness({
			persistSession: true,
			isolateSessionStorage: true,
			settings: { rustCell: { rustdocToolchain: RUSTDOC_TEST_TOOLCHAIN } },
		});
		const h = harness;
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("rust", {
					code: 'use agent_lib::prelude::*; fn main() -> Result<()> { let api = rlm::api::describe("rlm::api::list")?; assert_eq!(api["items"][0]["kind"], "function"); println!("child inspected API"); Ok(()) }',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("child documented API"),
			fauxAssistantMessage("parent received completion"),
		]);
		const handle = await h.session.runRlmChild("Inspect the API");
		await vi.waitFor(
			() => {
				expect(
					h
						.eventsOfType("rlm_child_update")
						.some((event) => event.child.id === handle.rlm_child_id && event.child.status === "done"),
				).toBe(true);
				expect(h.session.getRlmChildRunStatus(handle.rlm_child_id)).toBeUndefined();
			},
			{ timeout: 180_000 },
		);
		const result = h.session
			.getRlmChildSession(handle.rlm_child_id)!
			.messages.find((message) => message.role === "toolResult")!;
		expect(result, getMessageText(result)).toMatchObject({ details: { status: "ok" } });
		expect(getMessageText(result)).toContain("child inspected API");
		await vi.waitFor(() => {
			expect(h.session.isStreaming).toBe(false);
			expect(h.session.getLastAssistantText()).toBe("parent received completion");
		});
	});
});
