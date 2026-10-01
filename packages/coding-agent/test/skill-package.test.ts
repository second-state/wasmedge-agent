import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import { createSkillPackageHostHandler } from "../src/core/skill-package.js";
import { loadSkillsFromDir } from "../src/core/skills.js";

const payload = {
	name: "word-count",
	description: 'Count words: "quoted"\nUse for text.',
	instructions: "Call `run(text: &str) -> usize`.",
	source: "pub fn run(text: &str) -> usize { text.split_whitespace().count() }\n",
};

describe("skills.package", () => {
	let root: string | undefined;
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});
	function setup(existingNames: string[] = []) {
		root = realpathSync(mkdtempSync(join(tmpdir(), "skill-package-")));
		const cwd = join(root, "project");
		mkdirSync(cwd);
		const skills = join(cwd, CONFIG_DIR_NAME, "skills");
		return { cwd, skills, handler: createSkillPackageHostHandler({ cwd, existingNames: () => existingNames }) };
	}

	it("creates a discoverable Rust crate and preserves quoted frontmatter and source", async () => {
		const { skills, handler } = setup();
		const result = await handler({ ...payload, cellSourceCode: "host metadata" });
		expect(result).toEqual({
			path: `/workspace/${CONFIG_DIR_NAME}/skills/word-count`,
			crate_name: "word_count",
			rust_use: "agent_lib::skills::word_count",
			requires_reload: true,
		});
		const loaded = loadSkillsFromDir({ dir: skills, source: "project" });
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.skills).toMatchObject([{ name: payload.name, description: payload.description, kind: "rust" }]);
		expect(readFileSync(join(skills, payload.name, "src/lib.rs"), "utf-8")).toBe(payload.source);
	});

	it.each([
		"../escape",
		"/absolute",
		"foo/bar",
		"foo\\bar",
		"UPPER",
		"123",
		"-foo",
		"foo--bar",
		"foo-",
		"a".repeat(65),
		"fn",
		"self",
		"agent-lib",
		"serde-json",
	])("rejects invalid or reserved name %s before creating directories", async (name) => {
		const { cwd, handler } = setup();
		await expect(handler({ ...payload, name })).rejects.toThrow();
		expect(existsSync(join(cwd, CONFIG_DIR_NAME))).toBe(false);
	});

	it.each([
		{ description: " " },
		{ description: "x".repeat(1025) },
		{ instructions: "" },
		{ instructions: "x".repeat(64 * 1024 + 1) },
		{ source: null },
		{ source: "x".repeat(256 * 1024 + 1) },
		{ scope: "global" },
		{ path: "/outside" },
		{ dependencies: ["other"] },
	])("rejects invalid payload %j before writing", async (fields) => {
		const { cwd, handler } = setup();
		await expect(handler({ ...payload, ...fields })).rejects.toThrow();
		expect(existsSync(join(cwd, CONFIG_DIR_NAME))).toBe(false);
	});

	it.each(["directory", "file", "symlink", "dangling symlink"])("does not overwrite an existing %s", async (kind) => {
		const { skills, handler } = setup();
		mkdirSync(skills, { recursive: true });
		const destination = join(skills, payload.name);
		const other = join(root!, "other");
		if (kind === "directory") mkdirSync(destination);
		else if (kind === "file") writeFileSync(destination, "keep");
		else {
			if (kind === "symlink") mkdirSync(other);
			symlinkSync(other, destination);
		}
		await expect(handler(payload)).rejects.toThrow();
		expect(existsSync(join(destination, "Cargo.toml"))).toBe(false);
		if (kind === "file") expect(readFileSync(destination, "utf-8")).toBe("keep");
	});

	it.each(["config", "skills"])("rejects a symlink at the %s parent", async (parent) => {
		const { cwd, skills, handler } = setup();
		const outside = join(root!, "outside");
		mkdirSync(outside);
		if (parent === "skills") mkdirSync(join(cwd, CONFIG_DIR_NAME));
		symlinkSync(outside, parent === "skills" ? skills : join(cwd, CONFIG_DIR_NAME));
		await expect(handler(payload)).rejects.toThrow("without symlinks");
		expect(existsSync(join(outside, payload.name))).toBe(false);
	});

	it.each(["word-count", "word_count"])("rejects collisions with loaded skill %s", async (name) => {
		const { cwd, handler } = setup([name]);
		await expect(handler(payload)).rejects.toThrow("already loaded");
		expect(existsSync(join(cwd, CONFIG_DIR_NAME))).toBe(false);
	});

	it("does not write for an already cancelled request", async () => {
		const { cwd, handler } = setup();
		await expect(handler(payload, { signal: AbortSignal.abort() })).rejects.toThrow();
		expect(existsSync(join(cwd, CONFIG_DIR_NAME))).toBe(false);
	});
});
