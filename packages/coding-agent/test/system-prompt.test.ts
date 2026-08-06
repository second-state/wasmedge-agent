import { describe, expect, it } from "vitest";
import { buildRlmPrompt, buildSubagentGuidance } from "../src/core/prompts/index.js";
import { formatHarnessStateForPrompt, type HarnessState } from "../src/core/refinement/index.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

const BASE = { cwd: "/tmp/proj", messagesPath: "/tmp/log.jsonl" };

function makeSkill(name: string): Skill {
	return {
		kind: "markdown",
		name,
		description: `${name} skill`,
		filePath: `/x/${name}/SKILL.md`,
		baseDir: `/x/${name}`,
		sourceInfo: createSyntheticSourceInfo(`/x/${name}/SKILL.md`, { source: "package" }),
		disableModelInvocation: false,
	};
}

function emptyHarnessState(): HarnessState {
	return {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: [],
	} as unknown as HarnessState;
}

describe("buildRlmPrompt (rust doctrine, DESIGN §3)", () => {
	it("includes the rust-cell control doctrine and the fixed prelude", () => {
		const prompt = buildRlmPrompt({ ...BASE, activeTools: ["rust", "bash"] });
		expect(prompt).toContain("The rust tool is your control environment");
		expect(prompt).toContain("compiled to wasm32-wasip1");
		expect(prompt).toContain("Variables do NOT persist between cells");
		expect(prompt).toContain('rlm::state::set("key", &value)?');
		expect(prompt).toContain("Prelude crates available in cells: serde, serde_json, anyhow, regex, walkdir.");
		expect(prompt).toContain("This set is fixed: you cannot add");
		expect(prompt).toContain("Working directory (mounted at /workspace): /tmp/proj");
	});

	it("carries no kernel-era Python doctrine", () => {
		const prompt = buildRlmPrompt({
			...BASE,
			activeTools: ["rust", "bash"],
			installedSkills: ["agent_message", "agent_observe", "refine", "edit"],
		});
		expect(prompt).not.toContain("IPython");
		expect(prompt).not.toContain("%%bash");
		expect(prompt).not.toContain("await rlm(");
		expect(prompt).not.toContain("pre-imported");
		expect(prompt).not.toContain("asyncio");
	});

	it("teaches spawn mechanics only when recursion is allowed and rust is active", () => {
		const withRecursion = buildRlmPrompt({ ...BASE, activeTools: ["rust"] });
		expect(withRecursion).toContain('rlm::spawn("sub-task")?');
		expect(withRecursion).toContain('rlm::spawn_named("sub-task", "api-reviewer")?');
		expect(withRecursion).toContain("rlm::find_models(query, limit)?");

		const noRecursion = buildRlmPrompt({ ...BASE, activeTools: ["rust"], allowRecursion: false });
		expect(noRecursion).not.toContain("rlm::spawn");

		const noRust = buildRlmPrompt({ ...BASE, activeTools: ["bash"] });
		expect(noRust).not.toContain("rlm::spawn");
		expect(noRust).not.toContain("The rust tool is your control environment");
	});

	it("gates messaging and observation call forms on the matching skills", () => {
		const withBoth = buildRlmPrompt({
			...BASE,
			activeTools: ["rust"],
			installedSkills: ["agent_message", "agent_observe"],
		});
		expect(withBoth).toContain("rlm::msg::send_to_parent(message)?");
		expect(withBoth).toContain("rlm::msg::send_to_child(name, message)?");
		expect(withBoth).toContain("rlm::observe::*");

		// The §3.2 core doctrine always names rlm::msg as a capability; the
		// skill-gated lines are the recursion-block reply/discovery guidance.
		const withNeither = buildRlmPrompt({ ...BASE, activeTools: ["rust"] });
		expect(withNeither).not.toContain("Children reply explicitly with");
		expect(withNeither).not.toContain("rlm::msg::send_to_child(name, message)?");
		expect(withNeither).not.toContain("rlm::observe::*");
		expect(withNeither).toContain("rlm::list_subagents()?");
	});

	it("adds the child doctrine only for depth > 0", () => {
		const child = buildRlmPrompt({
			...BASE,
			activeTools: ["rust"],
			depth: 1,
			parentAgent: "root-1",
			installedSkills: ["agent_message"],
		});
		expect(child).toContain("You are a child agent spawned by root-1");
		expect(child).toContain("[task from parent]");
		expect(child).toContain("rlm::msg::send_to_parent(message)?");

		const root = buildRlmPrompt({ ...BASE, activeTools: ["rust"], depth: 0 });
		expect(root).not.toContain("child agent spawned");
	});

	it("appends the refine doctrine only when the refine skill is installed", () => {
		const withRefine = buildRlmPrompt({ ...BASE, activeTools: ["rust"], installedSkills: ["refine"] });
		expect(withRefine).toContain("rlm::refine::run(None, false)?");

		const without = buildRlmPrompt({ ...BASE, activeTools: ["rust"] });
		expect(without).not.toContain("rlm::refine::run");
	});
});

describe("buildSubagentGuidance", () => {
	it("uses rust call forms and gates optional capabilities", () => {
		const full = buildSubagentGuidance({
			includeRefineExamples: true,
			hasAgentMessage: true,
			hasAgentObserve: true,
		});
		expect(full).toContain("# Delegating to sub-agents");
		expect(full).toContain('rlm::spawn_named("task", "worker")?');
		expect(full).toContain("rlm::msg::send_to_parent(message)?");
		expect(full).toContain("rlm::observe::*");
		expect(full).toContain("rlm::refine::run(None, false)?");

		const minimal = buildSubagentGuidance({
			includeRefineExamples: false,
			hasAgentMessage: false,
			hasAgentObserve: false,
		});
		expect(minimal).not.toContain("rlm::msg::send_to_parent");
		expect(minimal).not.toContain("rlm::observe::*");
		expect(minimal).not.toContain("rlm::refine::run");
	});
});

describe("buildSystemPrompt", () => {
	it("assembles doctrine, subagent guidance, and harness state in order", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp/proj",
			selectedTools: ["rust", "bash"],
			harnessState: emptyHarnessState(),
		});
		const doctrineIndex = prompt.indexOf("The rust tool is your control environment");
		const guidanceIndex = prompt.indexOf("# Delegating to sub-agents");
		const harnessIndex = prompt.indexOf("# Continual Harness State");
		expect(doctrineIndex).toBeGreaterThan(-1);
		expect(guidanceIndex).toBeGreaterThan(doctrineIndex);
		expect(harnessIndex).toBeGreaterThan(guidanceIndex);
	});

	it("uses the rust harness call contract for rust sessions and the hint-only variant otherwise", () => {
		const rust = buildSystemPrompt({
			cwd: "/tmp/proj",
			selectedTools: ["rust", "bash"],
			harnessState: emptyHarnessState(),
		});
		expect(rust).toContain('let handle = rlm::spawn("<task>")?;');

		const bashOnly = buildSystemPrompt({
			cwd: "/tmp/proj",
			selectedTools: ["bash"],
			harnessState: emptyHarnessState(),
		});
		expect(bashOnly).toContain("routing/context hints only in sessions without the rust tool");
		expect(bashOnly).not.toContain('let handle = rlm::spawn("<task>")?;');
	});

	it("keeps a custom prompt free of the built-in doctrine but appends context and skills", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp/proj",
			customPrompt: "You are a haiku bot.",
			selectedTools: ["rust"],
			skills: [makeSkill("websearch")],
			contextFiles: [{ path: "AGENTS.md", content: "be nice" }],
		});
		expect(prompt).toContain("You are a haiku bot.");
		expect(prompt).not.toContain("The rust tool is your control environment");
		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("websearch");
		expect(prompt).toContain("Current working directory: /tmp/proj");
	});

	it("omits the skills section without file access", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp/proj",
			customPrompt: "custom",
			selectedTools: [],
			skills: [makeSkill("websearch")],
		});
		expect(prompt).not.toContain("websearch skill");
	});

	it("dedupes prompt guidelines", () => {
		const prompt = buildSystemPrompt({
			cwd: "/tmp/proj",
			selectedTools: ["rust"],
			promptGuidelines: ["be terse", "be terse", "  be terse  ", "cite sources"],
		});
		const occurrences = prompt.split("- be terse").length - 1;
		expect(occurrences).toBe(1);
		expect(prompt).toContain("- cite sources");
	});
});

describe("formatHarnessStateForPrompt call-contract variants", () => {
	it("treats the legacy ipython flag as the rust variant", () => {
		const state = emptyHarnessState();
		const viaLegacyFlag = formatHarnessStateForPrompt(state, { includeIpythonExamples: true });
		expect(viaLegacyFlag).toContain('rlm::spawn("<task>")?');
		expect(viaLegacyFlag).not.toContain("await rlm(");
	});

	it("annotates subagent entries with the spawn hint only in rust sessions", () => {
		const state = emptyHarnessState();
		(state.entries.subagent as Record<string, unknown>).reviewer = {
			id: "reviewer",
			kind: "subagent",
			title: "Reviewer",
			content: "Reviews changes.",
			path: "000",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "test",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			version: 1,
		};
		const rust = formatHarnessStateForPrompt(state, { includeRustExamples: true });
		expect(rust).toContain('spawning with `rlm::spawn("<task>")?`');
		const hints = formatHarnessStateForPrompt(state, { includeRustExamples: false, includeShellExamples: true });
		expect(hints).not.toContain("spawning with");
	});
});
