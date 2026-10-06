import { skillTestFingerprint } from "./skill-fingerprint.js";
import { type SkillTestOptions, skillReferenceCrate, testRustSkill } from "./skill-tests.js";
import { mountedSkillCrates } from "./workspace.js";

/** Cache only within one runtime; resumed harness entries must be tested anew. */
export class SkillValidation {
	private readonly passed = new Map<string, string>();

	constructor(private readonly options: Omit<SkillTestOptions, "signal">) {}

	async test(
		reference: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs = this.options.timeoutMs,
	): Promise<void> {
		const crate = skillReferenceCrate(reference);
		const fingerprint = skillTestFingerprint(
			this.options.workspaceDir,
			mountedSkillCrates(this.options.workspaceDir),
		);
		await testRustSkill(reference, { ...this.options, signal, timeoutMs });
		signal?.throwIfAborted();
		if (
			skillTestFingerprint(this.options.workspaceDir, mountedSkillCrates(this.options.workspaceDir)) !== fingerprint
		) {
			throw new Error(`Skill sources changed during testing: ${crate}; retry validation`);
		}
		this.passed.set(crate, fingerprint);
	}

	async revalidate(references: Record<string, unknown>[], signal: AbortSignal, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const crates = new Set(this.passed.keys());
		for (const reference of references) {
			if (reference.type === "rust") crates.add(skillReferenceCrate(reference));
		}
		if (crates.size === 0) return;
		const mounted = new Set(mountedSkillCrates(this.options.workspaceDir));
		for (const crate of crates) {
			if (!mounted.has(crate)) crates.delete(crate);
		}
		if (crates.size === 0) return;
		const fingerprint = skillTestFingerprint(this.options.workspaceDir, [...mounted]);
		for (const crate of crates) {
			signal.throwIfAborted();
			if (this.passed.get(crate) === fingerprint) continue;
			try {
				await this.test(
					{ type: "rust", use: `agent_lib::skills::${crate}` },
					signal,
					Math.max(0, deadline - Date.now()),
				);
			} catch (error) {
				throw new Error(
					`Skill ${crate} requires passing tests before the cell can run: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
		}
	}
}
