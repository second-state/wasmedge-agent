import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustCellProvisioner } from "../../src/core/rust-cell/index.js";
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

	it("restores a workspace whose only saved item is a tmp-named blob", async () => {
		const { artifacts, workspace: dir } = workspace("");
		mkdirSync(join(dir, "state/blobs/.rlm-write-0.tmp"), { recursive: true });
		writeFileSync(join(dir, "state/blobs/.rlm-write-0.tmp/value"), "interrupted write");
		writeFileSync(join(dir, "state/blobs/draft.tmp"), "saved blob content");
		const ensure = vi.spyOn(RustCellProvisioner.prototype, "ensure");
		const artifactDir = vi.spyOn(SessionManager.prototype, "getSessionArtifactDir").mockReturnValue(artifacts);
		const harness = await createHarness();
		harnesses.push(harness);
		artifactDir.mockRestore();
		let received = "";
		harness.setResponses([
			(context) => {
				received = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("reusing the saved blob");
			},
		]);
		await harness.session.prompt("continue");
		expect(received).toContain("<rust_state_restored>");
		expect(received).toContain("state blobs: draft.tmp.");
		expect(received).not.toMatch(/saved blob content|interrupted write|\.rlm-write-0/);
		expect(ensure).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom_message",
				customType: "rust_state_restored",
				content: expect.stringContaining("state blobs: draft.tmp."),
			}),
		);
	});

	async function compactionHarness(artifacts?: string): Promise<Harness> {
		const artifactDir = vi.spyOn(SessionManager.prototype, "getSessionArtifactDir").mockReturnValue(artifacts);
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
		artifactDir.mockRestore();
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		return harness;
	}

	it("lists current disk state after compaction before the first cell and persists the notice", async () => {
		const { artifacts, workspace: dir } = workspace("pub struct Old;");
		const ensure = vi.spyOn(RustCellProvisioner.prototype, "ensure");
		const harness = await compactionHarness(artifacts);
		writeFileSync(join(dir, "agent_lib/src/lib.rs"), "pub type Current = u64;");
		mkdirSync(join(dir, "state/blobs"), { recursive: true });
		writeFileSync(join(dir, "state/state.json"), JSON.stringify({ progress: "saved state value" }));
		writeFileSync(join(dir, "state/blobs/results.bin"), "saved blob content");
		writeFileSync(join(dir, "state/blobs/pending.tmp"), "saved tmp blob content");
		mkdirSync(join(dir, "state/blobs/.rlm-write-0.tmp"));
		writeFileSync(join(dir, "state/blobs/.rlm-write-0.tmp/value"), "interrupted write");
		await harness.session.compact();
		const notice = "agent_lib types (source scan): Current.";
		const entry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === "rust_state");
		expect(entry).toMatchObject({ content: expect.stringContaining(notice) });
		expect(entry).toMatchObject({ content: expect.stringContaining("state keys: progress.") });
		expect(entry).toMatchObject({ content: expect.stringContaining("state blobs: pending.tmp, results.bin.") });
		let received = "";
		harness.setResponses([
			(context) => {
				received = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("continued");
			},
		]);
		await harness.session.prompt("continue");
		expect(received).toContain(notice);
		expect(received).toContain("state keys: progress.");
		expect(received).toContain("state blobs: pending.tmp, results.bin.");
		expect(received).not.toContain("types (source scan): Old");
		expect(received).not.toMatch(
			/saved state value|saved blob content|saved tmp blob content|interrupted write|\.rlm-write-0/,
		);
		expect(ensure).not.toHaveBeenCalled();
	});

	it("does not claim a workspace persisted when no workspace exists", async () => {
		const ensure = vi.spyOn(RustCellProvisioner.prototype, "ensure");
		const harness = await compactionHarness();
		await harness.session.compact();
		expect(harness.sessionManager.getEntries()).not.toContainEqual(
			expect.objectContaining({ type: "custom_message", customType: "rust_state" }),
		);
		expect(ensure).not.toHaveBeenCalled();
	});

	it("resumes a workspace with an unreadable blob store even when only warnings remain", async () => {
		const { artifacts, workspace: dir } = workspace("");
		mkdirSync(join(dir, "state"));
		writeFileSync(join(dir, "state/blobs"), "not a directory");
		const artifactDir = vi.spyOn(SessionManager.prototype, "getSessionArtifactDir").mockReturnValue(artifacts);
		const harness = await createHarness();
		harnesses.push(harness);
		artifactDir.mockRestore();
		let received = "";
		harness.setResponses([
			(context) => {
				received = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("ready to repair the store");
			},
		]);
		await harness.session.prompt("continue");
		expect(received).toContain("<rust_state_restored>");
		expect(received).toContain("blob names are unavailable");
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom_message",
				customType: "rust_state_restored",
				content: expect.stringContaining("blob names are unavailable"),
				details: { restored: true, warnings: [expect.stringContaining("blob names are unavailable")] },
			}),
		);
	});

	it("compacts and continues with inventory warnings after stored data becomes unreadable", async () => {
		const { artifacts, workspace: dir } = workspace("pub struct Saved;");
		const ensure = vi.spyOn(RustCellProvisioner.prototype, "ensure");
		const harness = await compactionHarness(artifacts);
		mkdirSync(join(dir, "state"));
		writeFileSync(join(dir, "state/state.json"), '["invalid state map"]');
		writeFileSync(join(dir, "state/blobs"), "not a directory");
		await harness.session.compact();
		let received = "";
		harness.setResponses([
			(context) => {
				received = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("continuing with the readable library");
			},
		]);
		await harness.session.prompt("continue");
		expect(received).toContain("<rust_state>");
		expect(received).toContain("state keys are unavailable");
		expect(received).toContain("blob names are unavailable");
		expect(received).toContain("agent_lib types (source scan): Saved.");
		expect(received).not.toContain("no state keys yet");
		expect(received).not.toContain("state keys: 0");
		expect(ensure).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom_message",
				customType: "rust_state",
				content: expect.stringContaining("state keys are unavailable"),
			}),
		);
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
