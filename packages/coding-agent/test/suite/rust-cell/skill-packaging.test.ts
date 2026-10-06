import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../../src/config.js";
import { getLocalHarnessStateDir, loadHarnessState } from "../../../src/core/refinement/index.js";
import { isTemplateWarm, resolveToolchain } from "../../../src/core/rust-cell/toolchain.js";
import { loadSkillsFromDir, type Skill } from "../../../src/core/skills.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("skill packaging (real WasmEdge, faux provider)", () => {
	let harness: Harness | undefined;
	let reloadedFaux: ReturnType<typeof registerFauxProvider> | undefined;
	let agentDir: string | undefined;
	const originalAgentDir = process.env.WASMEDGE_AGENT_CODING_AGENT_DIR;
	afterEach(async () => {
		await harness?.session.disposeAsync();
		reloadedFaux?.unregister();
		harness?.cleanup();
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
		if (originalAgentDir === undefined) delete process.env.WASMEDGE_AGENT_CODING_AGENT_DIR;
		else process.env.WASMEDGE_AGENT_CODING_AGENT_DIR = originalAgentDir;
	});

	async function cell(code: string) {
		const h = harness!;
		const priorResults = h.session.messages.filter((message) => message.role === "toolResult").length;
		(reloadedFaux ?? h.faux).setResponses([
			fauxAssistantMessage(fauxToolCall("rust", { code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("Use the Rust skill API");
		expect(h.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(priorResults + 1);
		const result = h.session.messages.filter((message) => message.role === "toolResult").at(-1)!;
		expect(result, getMessageText(result)).toMatchObject({ isError: false });
		return getMessageText(result);
	}

	it("scaffolds through the bridge, mounts on reload, and retains the registration test gate", {
		timeout: 300_000,
	}, async () => {
		agentDir = mkdtempSync(join(tmpdir(), "skill-package-agent-"));
		process.env.WASMEDGE_AGENT_CODING_AGENT_DIR = agentDir;
		const resources = { skills: [] as Skill[] };
		const resourceLoader = createTestResourceLoader(resources);
		resourceLoader.reload = async () => {
			const loaded = loadSkillsFromDir({
				dir: join(harness!.tempDir, CONFIG_DIR_NAME, "skills"),
				source: "project",
			});
			expect(loaded.diagnostics).toEqual([]);
			resources.skills = loaded.skills;
		};
		harness = await createHarness({
			persistSession: true,
			isolateSessionStorage: true,
			settings: { rustCell: { cellTimeoutMs: 240_000 } },
			resourceLoader,
		});
		const source =
			'pub fn run(text: &str) -> usize { text.split_whitespace().count() }\n#[test] fn words() { assert_eq!(run("one two"), 2); }';
		await cell(`use agent_lib::prelude::*;
fn main() -> Result<()> {
    let source = r#"${source}"#;
    let skill = rlm::skills::package("word-count", "Count words.", "Call run(text: &str) -> usize.", source)?;
    assert!(skill.requires_reload);
    assert_eq!(skill.path, "/workspace/${CONFIG_DIR_NAME}/skills/word-count");
    assert_eq!(skill.crate_name, "word_count");
    assert_eq!(skill.rust_use, "agent_lib::skills::word_count");
    rlm::skills::package("bad-count", "Failing tests.", "Call run(text: &str) -> usize.", &source.replace(", 2)", ", 3)"))?;
    Ok(())
}`);
		const local = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
		expect(loadHarnessState(local, "local").entries.skill).toEqual({});
		await harness.session.reload();
		// Reload resets the provider registry, including the harness's faux API.
		reloadedFaux = registerFauxProvider({ api: harness.faux.api });
		expect(resources.skills.map((skill) => skill.name).sort()).toEqual(["bad-count", "word-count"]);
		const output = await cell(`use agent_lib::prelude::*;
fn main() -> Result<()> {
    assert_eq!(agent_lib::skills::word_count::run("one two three"), 3);
    let mut harness = rlm::harness::local()?;
    harness.create_skill("Word Count", "Count words", json!({"type":"rust","use":"agent_lib::skills::word_count","callable":"run"}), json!({}))?;
    let error = harness.create_skill("Bad Count", "Reject failing tests", json!({"type":"rust","use":"agent_lib::skills::bad_count","callable":"run"}), json!({})).unwrap_err();
    println!("{error}");
    Ok(())
}`);
		expect(output).toContain("sandboxed skill tests failed");
		expect(Object.keys(loadHarnessState(local, "local").entries.skill)).toEqual(["word_count"]);
	});
});
