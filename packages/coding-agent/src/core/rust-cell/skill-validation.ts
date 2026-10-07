import { skillTestFingerprintAsync } from "./skill-fingerprint.js";
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
		signal?.throwIfAborted();
		const deadline = Date.now() + timeoutMs;
		const timeout = AbortSignal.timeout(Math.max(0, timeoutMs));
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const crate = skillReferenceCrate(reference);
		const fingerprint = await skillTestFingerprintAsync(
			this.options.workspaceDir,
			mountedSkillCrates(this.options.workspaceDir),
			combined,
		);
		await testRustSkill(reference, {
			...this.options,
			signal: combined,
			timeoutMs: Math.max(0, deadline - Date.now()),
		});
		if (
			(await skillTestFingerprintAsync(
				this.options.workspaceDir,
				mountedSkillCrates(this.options.workspaceDir),
				combined,
			)) !== fingerprint
		) {
			throw new Error(`Skill sources changed during testing: ${crate}; retry validation`);
		}
		combined.throwIfAborted();
		this.passed.set(crate, fingerprint);
	}

	async revalidate(references: Record<string, unknown>[], signal: AbortSignal, timeoutMs: number): Promise<void> {
		signal.throwIfAborted();
		const deadline = Date.now() + timeoutMs;
		const combined = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, timeoutMs))]);
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
		const fingerprint = await skillTestFingerprintAsync(this.options.workspaceDir, [...mounted], combined);
		for (const crate of crates) {
			combined.throwIfAborted();
			if (this.passed.get(crate) === fingerprint) continue;
			try {
				await this.test(
					{ type: "rust", use: `agent_lib::skills::${crate}` },
					combined,
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
