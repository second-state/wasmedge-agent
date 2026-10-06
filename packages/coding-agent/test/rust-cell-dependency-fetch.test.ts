import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDependencyHandler } from "../src/core/rust-cell/dependencies.js";
import { readCellDependencies } from "../src/core/rust-cell/dependency-catalog.js";
import { dependencyTransactionDir } from "../src/core/rust-cell/dependency-transaction.js";
import { type ProcOutcome, runProcess } from "../src/core/rust-cell/process.js";
import { resolveTemplateDir, syncRustSkills } from "../src/core/rust-cell/workspace.js";

vi.mock("../src/core/rust-cell/process.js", () => ({ runProcess: vi.fn() }));
const success: ProcOutcome = { exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false };
const roots: string[] = [];
afterEach(() => {
	vi.resetAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "deps-fetch-test-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const template = resolveTemplateDir();
	cpSync(template, workspace, {
		recursive: true,
		filter: (path) => ![join(template, "target"), join(template, "vendor")].includes(path),
	});
	mkdirSync(join(workspace, "vendor"));
	writeFileSync(join(workspace, "vendor/retained"), "old source");
	writeFileSync(join(workspace, ".workspace-version"), "{}");
	const skill = join(workspace, "skills/example");
	mkdirSync(join(skill, "src"), { recursive: true });
	writeFileSync(join(skill, "src/lib.rs"), "pub fn value() {}\n");
	writeFileSync(
		join(skill, "Cargo.toml"),
		'[package]\nname="example"\nversion="0.1.0"\n[dependencies]\nunapproved="1"\n',
	);
	syncRustSkills(workspace, [
		{ name: "example", crateName: "example", cratePath: skill, cargoTomlPath: join(skill, "Cargo.toml") },
	]);
	mkdirSync(join(workspace, "skills/unmounted"));
	writeFileSync(join(workspace, "skills/unmounted/Cargo.toml"), "[package\n");
	const handler = createDependencyHandler({
		workspace,
		template,
		cargoBin: "cargo",
		configured: [],
		timeoutMs: 10_000,
	});
	return { workspace, handler };
}

describe("curated dependency fetching", () => {
	it("resolves existing vendor sources offline without fetching", async () => {
		const { workspace, handler } = fixture();
		vi.mocked(runProcess).mockResolvedValue(success);
		await handler({ crate_name: "itoa" }, { signal: new AbortController().signal });
		expect(vi.mocked(runProcess).mock.calls.map(([, args]) => args)).toEqual([
			["metadata", "--offline", "--format-version", "1"],
			["build", "--release", "--offline", "-p", "cell"],
		]);
		expect(readCellDependencies(workspace)).toEqual(["itoa"]);
	});
	it.each(["success", "fetch failure", "build failure", "timeout", "abort"])(
		"handles %s without publishing incomplete sources",
		async (mode) => {
			const { workspace, handler } = fixture();
			const lock = readFileSync(join(workspace, "Cargo.lock"), "utf-8");
			const manifest = readFileSync(join(workspace, "Cargo.toml"), "utf-8");
			const controller = new AbortController();
			vi.mocked(runProcess).mockImplementation(async (_bin, args, options) => {
				expect(options.signal).toBe(controller.signal);
				expect(options.timeoutMs).toBeGreaterThan(0);
				expect(options.timeoutMs).toBeLessThanOrEqual(10_000);
				const stagedManifest = readFileSync(join(options.cwd, "Cargo.toml"), "utf-8");
				expect(stagedManifest).not.toContain("skills/unmounted");
				if (args[0] === "metadata") return { ...success, exitCode: 101, stderr: "missing crate" };
				if (args[0] === "vendor") {
					expect(args).toEqual(["vendor", "--no-delete", "vendor"]);
					expect(stagedManifest).not.toContain("skills/example");
					expect(stagedManifest).toContain('hex = { version = "=0.4.3"');
					writeFileSync(join(options.cwd, "vendor/fetched"), "new source");
					writeFileSync(join(options.cwd, "Cargo.lock"), "new lock");
					if (mode === "abort") controller.abort();
					if (mode === "fetch failure") return { ...success, exitCode: 101, stderr: "registry unavailable" };
					if (mode === "timeout") return { ...success, exitCode: null, timedOut: true };
				} else {
					expect(args).toEqual(["build", "--release", "--offline", "-p", "cell"]);
					expect(stagedManifest).toContain("skills/example");
					if (mode === "build failure") return { ...success, exitCode: 101, stderr: "compile failed" };
				}
				return success;
			});
			const request = handler({ crate_name: "hex" }, { signal: controller.signal });
			if (mode === "success") {
				await expect(request).resolves.toEqual({ already_available: false });
				expect(readFileSync(join(workspace, "vendor/fetched"), "utf-8")).toBe("new source");
				expect(readFileSync(join(workspace, "Cargo.lock"), "utf-8")).toBe("new lock");
				expect(readCellDependencies(workspace)).toEqual(["hex"]);
				const calls = vi.mocked(runProcess).mock.calls.length;
				await expect(handler({ crate_name: "hex" }, { signal: controller.signal })).resolves.toEqual({
					already_available: true,
				});
				expect(runProcess).toHaveBeenCalledTimes(calls);
			} else {
				await expect(request).rejects.toThrow(mode === "abort" ? /abort/i : /Dependency (fetch|build) failed/);
				expect(existsSync(join(workspace, "vendor/fetched"))).toBe(false);
				expect(readFileSync(join(workspace, "Cargo.lock"), "utf-8")).toBe(lock);
				expect(readFileSync(join(workspace, "Cargo.toml"), "utf-8")).toBe(manifest);
				expect(readCellDependencies(workspace)).toEqual([]);
			}
			expect(readFileSync(join(workspace, "vendor/retained"), "utf-8")).toBe("old source");
			expect(readFileSync(join(workspace, "skills/unmounted/Cargo.toml"), "utf-8")).toBe("[package\n");
			expect(existsSync(dependencyTransactionDir(workspace))).toBe(false);
		},
	);
});
