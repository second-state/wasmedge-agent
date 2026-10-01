import { describe, expect, it, vi } from "vitest";
import {
	applyRefinementProposal,
	type HarnessState,
	type RefinementEdit,
	type RefinementProposal,
	testRefinementSkills,
} from "../src/core/refinement/index.js";

function skill(action: "create" | "update" = "create"): RefinementEdit {
	return {
		action,
		kind: "skill",
		id: "parser",
		title: "Parser",
		content: "Parse input",
		reference: { type: "rust", use: "agent_lib::skills::parser", callable: "run" },
		arguments: {},
	};
}

function proposal(...edits: RefinementEdit[]): RefinementProposal {
	return { summary: "Register skills", rationale: "Repeated parsing", expectedOutcome: "Reusable parser", edits };
}

function state(): HarnessState {
	return { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] };
}

describe("refinement skill test gate", () => {
	it("fails closed without test results or a sandbox validator", async () => {
		const store = state();
		const pending = proposal(skill());
		expect(applyRefinementProposal(store, pending, { id: "unverified" }).appliedEdits[0]).toMatchObject({
			applied: false,
			error: expect.stringContaining("must pass"),
		});
		const results = await testRefinementSkills(pending);
		expect(
			applyRefinementProposal(store, pending, { id: "unavailable", skillTestResults: results }).appliedEdits[0],
		).toMatchObject({ applied: false, error: "sandboxed skill tests are unavailable" });
		expect(store.entries.skill).toEqual({});
	});

	it("tests creates and updates, preserves a failed update, and allows unrelated edits and deletion", async () => {
		const store = state();
		const create = proposal(skill());
		const validate = vi.fn().mockResolvedValue(undefined);
		const first = await testRefinementSkills(create, validate);
		expect(
			applyRefinementProposal(store, create, { id: "create", skillTestResults: first }).appliedEdits[0].applied,
		).toBe(true);
		const original = structuredClone(store.entries.skill.parser);
		validate.mockRejectedValue(new Error("assertion failed"));
		const update = proposal(skill("update"), {
			action: "create",
			kind: "memory",
			id: "note",
			title: "Note",
			content: "Keep",
		});
		const results = await testRefinementSkills(update, validate);
		const applied = applyRefinementProposal(store, update, { id: "update", skillTestResults: results });
		expect(applied.appliedEdits.map((edit) => edit.applied)).toEqual([false, true]);
		expect(applied.appliedEdits[0].error).toBe("assertion failed");
		expect(store.entries.skill.parser).toEqual(original);
		const deletion = proposal({ action: "delete", kind: "skill", id: "parser" });
		await testRefinementSkills(deletion, validate);
		expect(applyRefinementProposal(store, deletion, { id: "delete" }).appliedEdits[0].applied).toBe(true);
		expect(validate).toHaveBeenCalledTimes(2);
	});

	it("does not reuse results for a later proposal and does not test invalid edits", async () => {
		const pending = proposal(skill());
		const validate = vi.fn().mockResolvedValue(undefined);
		const results = await testRefinementSkills(pending, validate);
		const later = proposal(skill());
		expect(
			applyRefinementProposal(state(), later, { id: "later", skillTestResults: results }).appliedEdits[0].applied,
		).toBe(false);
		await testRefinementSkills(proposal({ ...skill(), arguments: undefined }), validate);
		expect(validate).toHaveBeenCalledTimes(1);
	});

	it("propagates cancellation instead of applying a partially tested proposal", async () => {
		const abort = new AbortController();
		const validate = vi.fn(async () => {
			abort.abort(new Error("cancelled"));
		});
		await expect(testRefinementSkills(proposal(skill()), validate, abort.signal)).rejects.toThrow("cancelled");
	});
});
