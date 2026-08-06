import { RUST_PRELUDE_LABELS, rustControlPromptSection } from "./rust-rlm.js";

export interface RlmPromptOptions {
	cwd: string;
	skillsDir?: string;
	installedSkills?: string[];
	messagesPath: string;
	allowRecursion?: boolean;
	depth?: number;
	parentAgent?: string;
	activeTools?: string[];
}

export interface ChildAgentDoctrineOptions {
	depth?: number;
	parentAgent?: string;
	installedSkills?: string[];
	activeTools?: string[];
}

export function buildChildAgentDoctrine(options: ChildAgentDoctrineOptions): string | undefined {
	const depth = options.depth ?? 0;
	const hasRust = options.activeTools === undefined || options.activeTools.includes("rust");
	const hasAgentMessage = options.installedSkills?.includes("agent_message") ?? false;
	if (depth <= 0) return undefined;

	const lines = [
		`You are a child agent spawned by ${options.parentAgent ?? "your parent agent"}. Task prompts are labeled \`[task from parent]\`.`,
	];
	if (hasAgentMessage && hasRust) {
		lines.push(
			"When a task calls for an answer, reply explicitly with `rlm::msg::send_to_parent(message)?` from a rust cell. Not every message or task needs a reply; continue cleanup after sending and go idle normally.",
		);
	}
	return lines.join("\n");
}

export function buildRlmPrompt(options: RlmPromptOptions): string {
	const { cwd, skillsDir, messagesPath } = options;
	const installedSkills = options.installedSkills ?? [];
	const hasAgentMessage = installedSkills.includes("agent_message");
	const hasAgentObserve = installedSkills.includes("agent_observe");
	const allowRecursion = options.allowRecursion ?? true;
	const depth = options.depth ?? 0;
	const activeTools = options.activeTools ?? [];
	const hasRust = options.activeTools === undefined ? true : activeTools.includes("rust");
	const parts = [
		"You are a general purpose agent that uses code to solve tasks.",
		"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
		"When you are done, stop calling tools and state your final answer.",
		"",
		`Working directory (mounted at /workspace): ${cwd}`,
		`Conversation log: ${messagesPath}`,
		`Recursive agent depth: ${depth}`,
		`Prelude crates available in cells: ${RUST_PRELUDE_LABELS}.`,
	];

	const childDoctrine = buildChildAgentDoctrine(options);
	if (childDoctrine) {
		parts.push("", childDoctrine);
	}

	const skillLines: string[] = [];
	if (skillsDir) {
		skillLines.push(`Local skills live under ${skillsDir}. Read their SKILL.md files when helpful.`);
	}
	if (installedSkills.length > 0 && hasRust) {
		// The skills XML section (appended later) carries names and descriptions;
		// cells can read the SKILL.md files. The rust skill-crate call contract
		// (agent_lib::skills::*) arrives with the skills migration (WP6).
		skillLines.push("Skill listings appear below; read a skill's SKILL.md from a rust cell before relying on it.");
	}
	if (skillLines.length > 0) {
		parts.push("", ...skillLines);
	}
	if (hasAgentMessage) {
		parts.push(
			"Agent messaging is restricted to your parent, siblings, and direct children; roots are siblings, and deeper communication relays through the intermediate child.",
		);
	}
	if (hasAgentObserve) {
		parts.push(
			"Agent observation is restricted to your parent, siblings, and direct children; roots are siblings, and deeper inspection relays through the intermediate child.",
		);
	}

	if (allowRecursion && hasRust) {
		parts.push(
			"",
			'Recursive subagents are ordinary rust-cell calls. `let h = rlm::spawn("sub-task")?;` admits a child agent and returns immediately with a handle (`rlm_child_id`, `name`, `session_dir`, `model`); it NEVER waits for or returns the child\'s answer.',
			'Choose a stable child name with `rlm::spawn_named("sub-task", "api-reviewer")?`; names must be unique among siblings. If omitted, the host generates a readable unique name.',
			"A child inherits your model. If a different model is explicitly requested, use `rlm::find_models(query, limit)?` and pass an exact returned selector via `rlm::spawn_with(prompt, SpawnOpts { model: Some(selector), ..Default::default() })?`. An unavailable requested model fails spawn; decide whether to retry or omit the model.",
		);
		if (hasAgentMessage) {
			parts.push(
				"Children reply explicitly with `rlm::msg::send_to_parent(message)?` when an answer is needed. Replies and follow-ups arrive as ordinary agent messages; not every task requires a reply.",
				"Use `rlm::msg::list_agents()?` to discover family and `rlm::list_subagents()?` to recover direct child handles. Use `rlm::msg::send_to_child(name, message)?` for follow-ups.",
			);
		} else {
			parts.push("Use `rlm::list_subagents()?` to recover direct child handles after admission.");
		}
		if (hasAgentObserve) {
			parts.push(
				"Use `rlm::observe::*` to inspect a child's rollout. Observation is restricted to your parent, siblings, and direct children; relay through the intermediate child for deeper descendants.",
			);
		} else {
			parts.push("Inspect files a child wrote when you need to collect its work without an observation capability.");
		}
		parts.push(
			"Spawn independent children in one cell, persist their handles into rlm::state, then end your turn instead of waiting. Multiple replies may arrive over multiple turns. Delete a direct child explicitly with `rlm::delete_subagent(id_or_name)?` when it is no longer needed.",
		);
	}

	if (hasRust) {
		parts.push("", rustControlPromptSection());
		if (installedSkills.includes("refine")) {
			parts.push(
				"",
				"Treat continual harness refinement as a small, evidence-backed update after observing a repeated failure or reusable tactic: diagnose the issue, update the smallest relevant continual harness component, validate on the next action, then record the outcome. Use `rlm::refine::run(None, false)?` to turn repeated delegation patterns into reusable subagent specs, repeated procedures into skills, durable facts/preferences into memories, and narrow behavioral policies into prompt addendums. It returns immediately and runs when the current turn ends, so continue working normally after calling it. Do not rewrite the whole continual harness when a focused memory, skill, prompt note, or subagent spec is enough.",
			);
		}
	}

	return parts.join("\n");
}

/**
 * Supplemental sub-agent delegation guidance, appended after the base RLM
 * prompt (see system-prompt.ts). The recursion block covers the mechanics
 * (`rlm::spawn` admission and handle management); this block adds the
 * when and why in the same When -> Why -> menu order Claude Code's Agent tool
 * uses. The subagent-spec menu itself renders just after this, inside the
 * harness-state block.
 */
export function buildSubagentGuidance(
	options: { includeRefineExamples?: boolean; hasAgentMessage?: boolean; hasAgentObserve?: boolean } = {},
): string {
	const lines = [
		"# Delegating to sub-agents",
		"",
		'Spawn independent, self-contained work with `let handle = rlm::spawn_named("task", "worker")?;`. This returns at admission, not completion; keep the handle (persist it into rlm::state) to stop or inspect the child later.',
	];
	if (options.hasAgentMessage) {
		lines.push(
			"Ask for an explicit reply when needed. A child replies with `rlm::msg::send_to_parent(message)?`; parent follow-ups use `rlm::msg::send_to_child(name, message)?`. Not every message needs a reply.",
		);
	}
	lines.push("Use `rlm::list_subagents()?` after compaction or a session restart.");
	if (options.hasAgentObserve) {
		lines.push("Use `rlm::observe::*` for bounded transcript inspection.");
	}
	lines.push(
		"Have children write files and read those files for fan-in.",
		"Delegate parallel context-heavy research or independent implementation; do a single known lookup, edit, or command inline.",
	);
	if (options.includeRefineExamples ?? true) {
		lines.push("Persist genuinely reusable delegation patterns with `rlm::refine::run(None, false)?`.");
	}
	return lines.join("\n");
}
