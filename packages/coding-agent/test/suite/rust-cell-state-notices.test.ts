import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustCellProvisioner } from "../../src/core/rust-cell/index.js";
import { listPersistentState } from "../../src/core/rust-cell/workspace.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

describe("Rust workspace state notices", () => {
	const dirs: string[] = [];
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.disposeAsync();
			harness.cleanup();
		}
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function workspace(source: string): { artifacts: string; workspace: string } {
		const artifacts = mkdtempSync(join(tmpdir(), "rust-state-notice-"));
		dirs.push(artifacts);
		const workspace = join(artifacts, "workspace");
		mkdirSync(join(workspace, "agent_lib/src"), { recursive: true });
		writeFileSync(join(workspace, "Cargo.toml"), "[workspace]\n");
		writeFileSync(join(workspace, "agent_lib/src/lib.rs"), source);
		return { artifacts, workspace };
	}

	it("delivers a type-only restored workspace to the next model turn", async () => {
		const { artifacts } = workspace("pub mod helpers { pub struct Record; pub enum Status { Ready } }");
		const artifactDir = vi.spyOn(SessionManager.prototype, "getSessionArtifactDir").mockReturnValue(artifacts);
		const harness = await createHarness();
		harnesses.push(harness);
		artifactDir.mockRestore();
		const notice = "agent_lib types (source scan): helpers::Record, helpers::Status.";
		let received = "";
		harness.setResponses([
			(context) => {
				received = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("reusing the saved types");
			},
		]);
		await harness.session.prompt("Continue with the existing library");
		expect(received).toContain("<rust_state_restored>");
		expect(received).toContain(notice);
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom_message",
				customType: "rust_state_restored",
				content: expect.stringContaining(notice),
			}),
		);
	});

	it("includes current types after compaction and persists the notice", async () => {
		const { workspace: dir } = workspace("pub struct Old;");
		// Exercise notification delivery with a real source scan, without provisioning a compiler/runtime.
		vi.spyOn(RustCellProvisioner.prototype, "hasRunner", "get").mockReturnValue(true);
		vi.spyOn(RustCellProvisioner.prototype, "listState").mockImplementation(() => listPersistentState(dir));
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "Conversation summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		writeFileSync(join(dir, "agent_lib/src/lib.rs"), "pub type Current = u64;");
		await harness.session.compact();
		const notice = "agent_lib types (source scan): Current.";
		const entry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "rust_state");
		expect(entry).toMatchObject({ content: expect.stringContaining(notice) });
		let received = "";
		harness.setResponses([
			(context) => {
				received = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("continued");
			},
		]);
		await harness.session.prompt("continue");
		expect(received).toContain(notice);
		expect(received).not.toContain("types (source scan): Old");
	});

	it("does not send a restore notice for an empty or private-only library", async () => {
		const { artifacts } = workspace("struct Private;");
		const artifactDir = vi.spyOn(SessionManager.prototype, "getSessionArtifactDir").mockReturnValue(artifacts);
		const harness = await createHarness();
		harnesses.push(harness);
		artifactDir.mockRestore();
		let received = "";
		harness.setResponses([
			(context) => {
				received = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("ready");
			},
		]);
		await harness.session.prompt("continue");
		expect(received).not.toContain("<rust_state_restored>");
	});
});
