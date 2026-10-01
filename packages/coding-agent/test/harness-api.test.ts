import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarnessHostHandler } from "../src/core/refinement/harness-api.js";
import {
	getHarnessStatePath,
	loadHarnessState,
	type SkillTestValidator,
	saveHarnessState,
} from "../src/core/refinement/refinement.js";

const reference = { type: "rust", use: "agent_lib::skills::example", callable: "run" };
const create = {
	scope: "local",
	operation: "create",
	kind: "skill",
	title: "Example",
	content: "v1",
	reference,
	arguments: {},
};

describe("host-owned harness API", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	function setup() {
		const root = mkdtempSync(join(tmpdir(), "harness-api-"));
		roots.push(root);
		const local = join(root, "local");
		const global = join(root, "global");
		const testSkill = vi.fn<SkillTestValidator>(async () => {});
		const resolveDirectory = (scope: string) => (scope === "local" ? local : global);
		const handler = createHarnessHostHandler({ resolveDirectory, testSkill });
		return { local, global, testSkill, handler, resolveDirectory };
	}

	it("preserves CRUD, scope prefixes, versions, metadata, and host-written entries", async () => {
		const f = setup();
		const call = (payload: Record<string, unknown>) => f.handler({ scope: "local", ...payload });
		await call({ operation: "open" });
		await call({ ...create, kind: "memory", title: "Build Uses Ninja", content: "first" });
		const state = loadHarnessState(f.local, "local");
		state.entries.memory.build_uses_ninja.metadata = { keep: true };
		state.entries.memory.build_uses_ninja.path = "build";
		saveHarnessState(f.local, state);
		const before = state.entries.memory.build_uses_ninja;
		await call({ ...create, kind: "prompt", title: "Note" });
		await call({ ...create, kind: "subagent", title: "Reviewer" });
		const updated = await call({
			operation: "update",
			kind: "memory",
			id: "local:build_uses_ninja",
			title: "Build",
			content: "second",
		});
		expect(updated.value).toMatchObject({
			...before,
			title: "Build",
			content: "second",
			version: 2,
			updated_at: expect.any(String),
		});
		expect(await call({ operation: "get", kind: "memory", id: "build_uses_ninja" })).toEqual(updated);
		expect((await call({ operation: "list" })).value).toMatchObject([
			{ kind: "prompt" },
			{ kind: "memory" },
			{ kind: "subagent" },
		]);
		expect((await call({ operation: "list", kind: "skill" })).value).toEqual([]);
		const event = await call({
			operation: "record_refinement",
			trigger: "manual",
			changes: ["one"],
			evidence: "test",
			outcome: "done",
		});
		expect(event.value).toMatchObject({ id: "refine_0001", changes: ["one"] });
		expect((await call({ operation: "overview" })).value).toContain(
			"[local:build_uses_ninja] Build (build, v2): second",
		);
		expect((await call({ operation: "overview" })).value).toContain("refinements: 1");
		await expect(call({ operation: "get", kind: "memory", id: "global:build_uses_ninja" })).rejects.toThrow(
			"global store",
		);
		await call({ ...create, scope: "global", kind: "memory", title: "Global" });
		expect(loadHarnessState(f.global).entries.memory.global.scope).toBe("global");
		expect(loadHarnessState(f.local).entries.memory.global).toBeUndefined();
		expect((await call({ operation: "delete", kind: "memory", id: "build_uses_ninja" })).value).toBe(true);
		expect((await call({ operation: "delete", kind: "memory", id: "build_uses_ninja" })).value).toBe(false);
		expect((await call({ operation: "get", kind: "memory", id: "build_uses_ninja" })).value).toBeNull();
		expect(f.testSkill).not.toHaveBeenCalled();
	});

	it("validates raw requests and ignores forged test results, paths, and entry metadata", async () => {
		const f = setup();
		for (const overrides of [
			{ reference: { type: "python" } },
			{ reference: {} },
			{ reference: { type: "rust", use: "x" } },
			{ arguments: [] },
			{ arguments: undefined },
			{ scope: "../elsewhere" },
			{ kind: "constructor" },
			{ operation: "save", state: {} },
			{ title: 1 },
		])
			await expect(f.handler({ ...create, ...overrides, passed: true })).rejects.toThrow();
		expect(f.testSkill).not.toHaveBeenCalled();
		f.testSkill.mockRejectedValueOnce(new Error("tests failed"));
		await expect(f.handler({ ...create, passed: true, skillTestResults: {} })).rejects.toThrow("tests failed");
		expect(loadHarnessState(f.local).entries.skill).toEqual({});
		await f.handler({
			...create,
			directory: f.global,
			path: "elsewhere",
			source: "refine",
			version: 99,
			metadata: { passed: true },
		});
		expect(loadHarnessState(f.local).entries.skill.example).toMatchObject({
			version: 1,
			source: "agent",
			path: "general",
			metadata: {},
		});
		expect(loadHarnessState(f.global).entries.skill).toEqual({});
		await expect(f.handler(create)).rejects.toThrow("already exists");
		await expect(f.handler({ ...create, operation: "update", id: "missing" })).rejects.toThrow("does not exist");
		await expect(f.handler({ ...create, kind: "prompt", title: "Base System Prompt" })).rejects.toThrow(
			"not editable",
		);
		await expect(createHarnessHostHandler({ resolveDirectory: () => undefined })(create)).rejects.toThrow(
			"unavailable",
		);
		await expect(
			createHarnessHostHandler({ resolveDirectory: f.resolveDirectory })({ ...create, title: "No Runtime" }),
		).rejects.toThrow("tests are unavailable");
	});

	it("tests both update forms and preserves the stored contract on a plain update or test failure", async () => {
		const f = setup();
		await f.handler(create);
		const changed = { ...reference, callable: "new_run" };
		await f.handler({
			...create,
			operation: "update",
			id: "example",
			reference: changed,
			arguments: { input: "optional" },
		});
		await f.handler({
			scope: "local",
			operation: "update",
			kind: "skill",
			id: "example",
			title: "Example",
			content: "v3",
		});
		expect(f.testSkill.mock.calls.map((call) => call[0])).toEqual([reference, changed, changed]);
		const before = loadHarnessState(f.local).entries.skill.example;
		expect(before).toMatchObject({ version: 3, reference: changed, arguments: { input: "optional" } });
		f.testSkill.mockRejectedValueOnce(new Error("tests failed"));
		await expect(f.handler({ ...create, operation: "update", id: "example" })).rejects.toThrow("tests failed");
		expect(loadHarnessState(f.local).entries.skill.example).toEqual(before);
	});

	it("reloads after tests, retaining unrelated same-mtime writes and rejecting same-entry conflicts", async () => {
		const f = setup();
		await f.handler({ ...create, kind: "memory", title: "Before" });
		f.testSkill.mockImplementationOnce(async () => {
			await f.handler({ ...create, kind: "memory", title: "Concurrent" });
			utimesSync(getHarnessStatePath(f.local), 1, 1);
		});
		utimesSync(getHarnessStatePath(f.local), 1, 1);
		await f.handler(create);
		expect(Object.keys(loadHarnessState(f.local).entries.memory)).toEqual(["before", "concurrent"]);
		f.testSkill.mockImplementationOnce(async () => {
			const state = loadHarnessState(f.local, "local");
			state.entries.skill.example.content = "from host";
			saveHarnessState(f.local, state);
		});
		await expect(f.handler({ ...create, operation: "update", id: "example" })).rejects.toThrow(
			"changed while tests ran",
		);
		expect(loadHarnessState(f.local).entries.skill.example.content).toBe("from host");
		f.testSkill.mockImplementationOnce(async () => {
			await f.handler({ ...create, kind: "memory", title: "During Failed Test" });
			throw new Error("tests failed");
		});
		await expect(f.handler({ ...create, title: "Rejected" })).rejects.toThrow("tests failed");
		await f.handler({ ...create, kind: "memory", title: "After" });
		expect(loadHarnessState(f.local).entries.memory.during_failed_test).toBeDefined();
	});

	it("does not save cancelled mutations or clobber concurrent creates", async () => {
		const f = setup();
		const abort = new AbortController();
		f.testSkill.mockImplementationOnce(async () => {
			abort.abort();
		});
		await expect(f.handler(create, { signal: abort.signal })).rejects.toThrow();
		expect(loadHarnessState(f.local).entries.skill).toEqual({});
		await expect(f.handler({ ...create, kind: "memory" }, { signal: abort.signal })).rejects.toThrow();
		expect(loadHarnessState(f.local).entries.memory).toEqual({});
		f.testSkill.mockImplementationOnce(async () => {
			await f.handler(create);
		});
		await expect(f.handler(create)).rejects.toThrow("changed while tests ran");
		expect(loadHarnessState(f.local).entries.skill.example.version).toBe(1);
	});
});
