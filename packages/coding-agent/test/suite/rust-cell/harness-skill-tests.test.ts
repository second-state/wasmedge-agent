import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	loadHarnessState,
} from "../../../src/core/refinement/index.js";
import { RustCellProvisioner } from "../../../src/core/rust-cell/index.js";
import * as skillTests from "../../../src/core/rust-cell/skill-tests.js";
import { isTemplateWarm, resolveToolchain } from "../../../src/core/rust-cell/toolchain.js";
import { loadSkillsFromDir } from "../../../src/core/skills.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("guest harness skill gate (real WasmEdge, faux provider)", () => {
	let harness: Harness | undefined;
	let root: string | undefined;
	const originalAgentDir = process.env.WASMEDGE_AGENT_CODING_AGENT_DIR;
	afterEach(async () => {
		await harness?.session.disposeAsync();
		harness?.cleanup();
		if (root) rmSync(root, { recursive: true, force: true });
		if (originalAgentDir === undefined) delete process.env.WASMEDGE_AGENT_CODING_AGENT_DIR;
		else process.env.WASMEDGE_AGENT_CODING_AGENT_DIR = originalAgentDir;
		vi.restoreAllMocks();
	});

	async function setup(source: string) {
		root = mkdtempSync(join(tmpdir(), "guest-skill-suite-"));
		process.env.WASMEDGE_AGENT_CODING_AGENT_DIR = join(root, "agent");
		const crate = join(root, "example");
		mkdirSync(join(crate, "src"), { recursive: true });
		writeFileSync(join(crate, "SKILL.md"), "---\nname: example\ndescription: Test example\n---\nCall run().\n");
		writeFileSync(join(crate, "Cargo.toml"), '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2021"\n');
		const lib = join(crate, "src/lib.rs");
		writeFileSync(lib, source);
		const { skills } = loadSkillsFromDir({ dir: root, source: "project" });
		harness = await createHarness({
			persistSession: true,
			isolateSessionStorage: true,
			settings: { rustCell: { cellTimeoutMs: 240_000 } },
			resourceLoader: createTestResourceLoader({ skills }),
		});
		return {
			h: harness,
			lib,
			local: getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!,
			global: getGlobalHarnessStateDir(),
		};
	}

	async function cell(h: Harness, code: string, status = "ok") {
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("rust", { code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("Use the harness API");
		const result = h.session.messages.filter((message) => message.role === "toolResult").at(-1)!;
		expect(result, getMessageText(result)).toMatchObject({ details: { status } });
		return getMessageText(result);
	}

	it("retests edited registered skills before cells and preserves harness entries on failure", {
		timeout: 300_000,
	}, async () => {
		const f = await setup("pub fn run() -> u32 { 42 }\n#[test] fn answer() { assert_eq!(run(), 42); }");
		await cell(
			f.h,
			`use agent_lib::prelude::*;
fn main() -> Result<()> {
    let reference = serde_json::json!({"type":"rust","use":"agent_lib::skills::example","callable":"run"});
    let mut local = rlm::harness::local()?;
    local.create_memory("Before", "keep before test")?;
    local.create_skill("Example", "v1", reference.clone(), serde_json::json!({}))?;
    local.update_skill("local:example", "Example", "v2", reference.clone(), serde_json::json!({"input":"optional"}))?;
    local.update("skill", "example", "Example", "v3")?;
    local.create_memory("After", "keep after test")?;
    rlm::harness::global()?.create_skill("Example", "global", reference, serde_json::json!({}))?;
    Ok(())
}`,
		);
		const before = loadHarnessState(f.local, "local");
		expect(before.entries.skill.example).toMatchObject({
			version: 3,
			content: "v3",
			arguments: { input: "optional" },
			source: "agent",
		});
		expect(Object.keys(before.entries.memory).sort()).toEqual(["after", "before"]);
		expect(loadHarnessState(f.global, "global").entries.skill.example).toMatchObject({
			scope: "global",
			version: 1,
		});
		const tests = vi.spyOn(skillTests, "testRustSkill");
		await cell(f.h, "fn main() { assert_eq!(agent_lib::skills::example::run(), 42); }");
		expect(tests).not.toHaveBeenCalled();
		writeFileSync(f.lib, "pub fn run() -> u32 { 43 }\n#[test] fn answer() { assert_eq!(run(), 42); }");
		const output = await cell(
			f.h,
			`use agent_lib::prelude::*;
fn main() -> Result<()> {
    let reference = serde_json::json!({"type":"rust","use":"agent_lib::skills::example","callable":"run"});
    let mut local = rlm::harness::local()?;
    println!("{}", local.create_skill("Rejected", "bad", reference.clone(), serde_json::json!({})).unwrap_err());
    assert!(local.update_skill("example", "Example", "bad", reference, serde_json::json!({})).is_err());
    assert!(local.update("skill", "example", "Example", "bad").is_err());
    local.create_memory("After Failure", "still writable")?;
    Ok(())
}`,
			"error",
		);
		expect(output).toContain("sandboxed skill tests failed");
		expect(tests).toHaveBeenCalledTimes(1);
		const after = loadHarnessState(f.local, "local");
		expect(after.entries.skill).toEqual(before.entries.skill);
		expect(after.entries.memory.after_failure).toBeUndefined();
		writeFileSync(f.lib, "pub fn run() -> u32 { 43 }\n#[test] fn answer() { assert_eq!(run(), 43); }");
		await cell(f.h, "fn main() { assert_eq!(agent_lib::skills::example::run(), 43); }");
		expect(tests).toHaveBeenCalledTimes(2);
		await cell(f.h, "fn main() { assert_eq!(agent_lib::skills::example::run(), 43); }");
		expect(tests).toHaveBeenCalledTimes(2);
	});

	it("cancels an in-flight host test when the calling cell is aborted", { timeout: 300_000 }, async () => {
		const f = await setup("pub fn run() {}\n#[test] fn hangs() { loop { std::hint::black_box(1); } }");
		const original = RustCellProvisioner.prototype.testSkill;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let settled!: () => void;
		const finished = new Promise<void>((resolve) => {
			settled = resolve;
		});
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(RustCellProvisioner.prototype, "testSkill").mockImplementation(async function (
			this: RustCellProvisioner,
			reference,
			signal,
		) {
			requestSignal = signal;
			const result = original.call(this, reference, signal);
			entered();
			try {
				await result;
			} finally {
				settled();
			}
		});
		f.h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("rust", {
					code: `use agent_lib::prelude::*;
fn main() -> Result<()> {
    rlm::harness::local()?.create_skill("Cancelled", "never persist", serde_json::json!({"type":"rust","use":"agent_lib::skills::example","callable":"run"}), serde_json::json!({}))?;
    Ok(())
}`,
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const prompt = f.h.session.prompt("Register the skill");
		await Promise.race([
			started,
			prompt.then(() => {
				throw new Error("cell did not reach the skill test gate");
			}),
		]);
		await f.h.session.abort();
		await prompt;
		await finished;
		expect(requestSignal?.aborted).toBe(true);
		expect(loadHarnessState(f.local, "local").entries.skill).toEqual({});
	});
});
