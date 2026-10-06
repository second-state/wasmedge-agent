import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CrateTestOptions, testRustCrate } from "./crate-tests.js";
import { mountedSkillCrates } from "./workspace.js";

export type SkillTestOptions = CrateTestOptions;

export function skillReferenceCrate(reference: Record<string, unknown>): string {
	const match =
		typeof reference.use === "string"
			? /^agent_lib::skills::([a-zA-Z_][a-zA-Z0-9_]*)(?:::[a-zA-Z_][a-zA-Z0-9_]*)*$/.exec(reference.use)
			: null;
	if (reference.type !== "rust" || !match)
		throw new Error("skill tests require an agent_lib::skills::<crate> reference");
	return match[1];
}

export async function testRustSkill(reference: Record<string, unknown>, options: SkillTestOptions): Promise<void> {
	const crateName = skillReferenceCrate(reference);
	const mounted = mountedSkillCrates(options.workspaceDir);
	if (!mounted.includes(crateName) || !existsSync(join(options.workspaceDir, "skills", crateName, "Cargo.toml"))) {
		throw new Error(`skill crate ${crateName} is not mounted; reload skills before refinement`);
	}
	await testRustCrate(crateName, options);
}
