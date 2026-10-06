import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_NAME_WARNINGS } from "../src/config.js";
import {
	formatSkillsForPrompt,
	getRustSkillRuntimeInfo,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillRustMetadata,
} from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");
const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

function createTestSkill(options: {
	name: string;
	description: string;
	disableModelInvocation?: boolean;
	rust?: SkillRustMetadata;
}): Skill {
	const filePath = `/path/${options.name}/SKILL.md`;
	const base = {
		name: options.name,
		description: options.description,
		filePath,
		baseDir: `/path/${options.name}`,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
	return options.rust ? { ...base, kind: "rust", rust: options.rust } : { ...base, kind: "markdown" };
}

function writeRustSkill(root: string, name: string): void {
	const skillDir = join(root, name);
	const crateName = name.replaceAll("-", "_");
	mkdirSync(join(skillDir, "src"), { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Test skill ${name}\n---\n\nUse this skill for tests.\n`,
	);
	writeFileSync(
		join(skillDir, "Cargo.toml"),
		`[package]\nname = "${crateName}"\nversion = "0.1.0"\nedition = "2021"\n`,
	);
	writeFileSync(join(skillDir, "src", "lib.rs"), 'pub fn run() -> &\'static str {\n    "ok"\n}\n');
}

describe("skills", () => {
	// One case table for loader validation: which fixtures load, under what names, and whether
	// the loader reports a diagnostic. Exact warning wording is not part of the contract.
	it.each([
		{ fixture: "valid-skill", names: ["valid-skill"], diagnostics: false },
		{ fixture: "unknown-field", names: ["unknown-field"], diagnostics: false },
		{ fixture: "multiline-description", names: ["multiline-description"], diagnostics: false },
		{ fixture: "nested", names: ["child-skill"], diagnostics: false },
		{ fixture: "root-skill-preferred", names: ["root-skill-preferred"], diagnostics: false },
		{ fixture: "disable-model-invocation", names: ["disable-model-invocation"], diagnostics: false },
		{ fixture: "name-mismatch", names: ["different-name"], diagnostics: true },
		{ fixture: "invalid-name-chars", names: undefined, diagnostics: true },
		{ fixture: "long-name", names: undefined, diagnostics: true },
		{ fixture: "consecutive-hyphens", names: undefined, diagnostics: true },
		{ fixture: "missing-description", names: [], diagnostics: true },
		{ fixture: "no-frontmatter", names: [], diagnostics: true },
		{ fixture: "invalid-yaml", names: [], diagnostics: true },
	])("loadSkillsFromDir($fixture)", ({ fixture, names, diagnostics }) => {
		const result = loadSkillsFromDir({ dir: join(fixturesDir, fixture), source: "test" });

		if (names) expect(result.skills.map((skill) => skill.name)).toEqual(names);
		else expect(result.skills).toHaveLength(1);
		expect(result.diagnostics.length > 0).toBe(diagnostics);
		for (const skill of result.skills) expect(skill.sourceInfo.source).toBe("test");
	});

	it("reads disable-model-invocation, defaulting to false", () => {
		const [disabled] = loadSkillsFromDir({
			dir: join(fixturesDir, "disable-model-invocation"),
			source: "test",
		}).skills;
		const [enabled] = loadSkillsFromDir({ dir: join(fixturesDir, "valid-skill"), source: "test" }).skills;

		expect(disabled.disableModelInvocation).toBe(true);
		expect(enabled.disableModelInvocation).toBe(false);
	});

	it("returns nothing for a non-existent directory", () => {
		const result = loadSkillsFromDir({ dir: "/non/existent/path", source: "test" });

		expect(result.skills).toHaveLength(0);
		expect(result.diagnostics).toHaveLength(0);
	});

	it("loads the whole fixture tree in one pass", () => {
		const { skills } = loadSkillsFromDir({ dir: fixturesDir, source: "test" });

		// Everything with a description loads, warnings and all; the rest is skipped.
		expect(skills.length).toBeGreaterThanOrEqual(6);
		expect(skills.map((skill) => skill.name)).not.toContain("missing-description");
	});

	it("reads Rust crate skill packaging from disk", () => {
		const skillDir = join(fixturesDir, "rust-skill");
		const { skills, diagnostics } = loadSkillsFromDir({ dir: skillDir, source: "test" });

		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			name: "rust-skill",
			kind: "rust",
			rust: { crateName: "rust_skill", cratePath: skillDir, cargoTomlPath: join(skillDir, "Cargo.toml") },
		});
		expect(getRustSkillRuntimeInfo(skills)).toEqual([
			{
				name: "rust-skill",
				crateName: "rust_skill",
				cratePath: skillDir,
				cargoTomlPath: join(skillDir, "Cargo.toml"),
			},
		]);
		expect(diagnostics).toHaveLength(0);
	});

	it("degrades a Rust skill to markdown when its crate lib.rs is missing", () => {
		const { skills, diagnostics } = loadSkillsFromDir({
			dir: join(fixturesDir, "rust-lib-missing"),
			source: "test",
		});

		expect(skills).toHaveLength(1);
		expect(skills[0].kind).toBe("markdown");
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	it("downgrades kernel-era python skills to markdown with a diagnostic", () => {
		const { skills, diagnostics } = loadSkillsFromDir({
			dir: join(fixturesDir, "python-skill"),
			source: "test",
		});

		expect(skills).toHaveLength(1);
		expect(skills[0].kind).toBe("markdown");
		expect(diagnostics.length).toBeGreaterThan(0);
	});

	describe("loadSkills", () => {
		it("loads explicit skillPaths as temporary skills and warns about missing ones", () => {
			const loaded = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
				includeDefaults: true,
			});
			expect(loaded.skills).toHaveLength(1);
			expect(loaded.skills[0].sourceInfo.scope).toBe("temporary");
			expect(loaded.diagnostics).toHaveLength(0);

			const missing = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: true,
			});
			expect(missing.skills).toHaveLength(0);
			expect(missing.diagnostics.length).toBeGreaterThan(0);
		});

		it("expands ~ in skillPaths", () => {
			const base = { agentDir: emptyAgentDir, cwd: emptyCwd, includeDefaults: true };
			const withTilde = loadSkills({ ...base, skillPaths: ["~/.pi/agent/skills"] });
			const withoutTilde = loadSkills({ ...base, skillPaths: [join(homedir(), ".pi/agent/skills")] });

			expect(withTilde.skills.length).toBe(withoutTilde.skills.length);
		});

		it("keeps the first skill on a name collision and reports the loser", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(collisionFixturesDir, "first"), join(collisionFixturesDir, "second")],
				includeDefaults: false,
			});

			expect(skills.map((skill) => skill.name)).toEqual(["calendar"]);
			expect(skills[0].filePath).toContain(join("skills-collision", "first"));
			const collisions = diagnostics.filter((diagnostic) => diagnostic.type === "collision");
			expect(collisions).toHaveLength(1);
			expect(collisions[0].collision).toMatchObject({
				resourceType: "skill",
				name: "calendar",
				winnerPath: skills[0].filePath,
			});
		});

		it("warns when two Rust skills share a crate name", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "wasmedge-agent-skills-"));
			try {
				writeRustSkill(tempDir, "web-search");
				writeRustSkill(tempDir, "web_search");

				const { skills, diagnostics } = loadSkills({
					agentDir: emptyAgentDir,
					cwd: emptyCwd,
					skillPaths: [tempDir],
					includeDefaults: false,
				});

				expect(skills.map((skill) => skill.name).sort()).toEqual(["web-search", "web_search"]);
				expect(diagnostics.length).toBeGreaterThan(0);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("formatSkillsForPrompt", () => {
		it.each([
			{ name: "no skills", skills: [] as Skill[], visible: [] as string[] },
			{
				name: "markdown and rust skills",
				skills: [
					createTestSkill({ name: "skill-one", description: "First skill." }),
					createTestSkill({
						name: "rust-skill",
						description: "A Rust skill.",
						rust: {
							crateName: "rust_skill",
							cratePath: "/path/rust-skill",
							cargoTomlPath: "/path/rust-skill/Cargo.toml",
						},
					}),
				],
				visible: ["skill-one", "rust-skill"],
			},
			{
				name: "model-invocation-disabled skills",
				skills: [
					createTestSkill({ name: "visible-skill", description: "A visible skill." }),
					createTestSkill({ name: "hidden-skill", description: "A hidden skill.", disableModelInvocation: true }),
				],
				visible: ["visible-skill"],
			},
			{
				name: "only disabled skills",
				skills: [createTestSkill({ name: "hidden-skill", description: "hidden", disableModelInvocation: true })],
				visible: [],
			},
		])("lists $name", ({ skills, visible }) => {
			const result = formatSkillsForPrompt(skills);

			if (visible.length === 0) {
				expect(result).toBe("");
				return;
			}
			expect([...result.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => match[1])).toEqual(visible);
		});

		it("tells the model to call Rust skills through their rust_use path", () => {
			const result = formatSkillsForPrompt([
				createTestSkill({
					name: "rust-skill",
					description: "A Rust skill.",
					rust: {
						crateName: "rust_skill",
						cratePath: "/path/rust-skill",
						cargoTomlPath: "/path/rust-skill/Cargo.toml",
					},
				}),
			]);

			expect(result).toContain("<type>rust</type>");
			expect(result).toContain("<rust_use>agent_lib::skills::rust_skill</rust_use>");
			expect(result).toContain("Read a skill's file in a rust cell");
			expect(result).not.toContain("ipython");
		});
	});

	describe("project-local fallback (.prime/agent)", () => {
		const dirs: string[] = [];

		afterEach(() => {
			for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
			LEGACY_NAME_WARNINGS.length = 0;
		});

		it("still discovers project skills under the legacy .prime/agent directory, and warns once", () => {
			const cwd = mkdtempSync(join(tmpdir(), "wasmedge-agent-project-skills-"));
			dirs.push(cwd);
			const legacySkillDir = join(cwd, ".prime", "agent", "skills", "legacy-skill");
			mkdirSync(legacySkillDir, { recursive: true });
			writeFileSync(
				join(legacySkillDir, "SKILL.md"),
				"---\nname: legacy-skill\ndescription: Lives under the pre-rebrand project directory.\n---\n\nBody.\n",
			);

			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd,
				skillPaths: [],
				includeDefaults: true,
			});

			expect(skills.map((s) => s.name)).toContain("legacy-skill");
			expect(diagnostics).toHaveLength(0);
			expect(LEGACY_NAME_WARNINGS).toHaveLength(1);
			expect(LEGACY_NAME_WARNINGS[0]).toContain(join(".prime", "agent"));
		});
	});
});
