import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { assertReadonlyWorkspaceMounts } from "../src/core/rust-cell/harness-mounts.js";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo } from "../src/core/rust-cell/toolchain.js";
import { ensureWorkspaceAt } from "../src/core/rust-cell/workspace.js";
import type { WorkspaceWritePolicy } from "../src/core/rust-cell/workspace-policy.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import { createRustToolDefinition } from "../src/core/tools/rust.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "workspace-policy-"));
	roots.push(root);
	return root;
}

describe("workspace access configuration", () => {
	it("defaults to rw, inherits global policy, and accepts a project override", () => {
		expect(SettingsManager.inMemory({}).getRustCellWorkspaceWritePolicy()).toBe("rw");
		const root = fixture();
		const project = join(root, "project");
		const agent = join(root, "agent");
		mkdirSync(agent);
		mkdirSync(join(project, ".wasmedge-agent"), { recursive: true });
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ rustCell: { workspaceWritePolicy: "ro" } }));
		expect(SettingsManager.create(project, agent).getRustCellWorkspaceWritePolicy()).toBe("ro");
		writeFileSync(
			join(project, ".wasmedge-agent", "settings.json"),
			JSON.stringify({ rustCell: { workspaceWritePolicy: "rw" } }),
		);
		expect(SettingsManager.create(project, agent).getRustCellWorkspaceWritePolicy()).toBe("rw");
	});

	it.each([null, "readonly", "", false, 0, {}])("rejects invalid policy %j before provisioning", (invalid) => {
		const workspaceWritePolicy = invalid as WorkspaceWritePolicy;
		expect(() =>
			SettingsManager.inMemory({ rustCell: { workspaceWritePolicy } }).getRustCellWorkspaceWritePolicy(),
		).toThrow("rustCell.workspaceWritePolicy");
		expect(() => new RustCellProvisioner({ cwd: "/unused", workspaceWritePolicy })).toThrow(
			"rustCell.workspaceWritePolicy",
		);
		expect(() => createRustToolDefinition("/unused", { workspaceWritePolicy })).toThrow(
			"rustCell.workspaceWritePolicy",
		);
		expect(
			() =>
				new CellRunner({
					cwd: "/unused",
					workspaceDir: "/unused",
					cargoBin: "unused",
					wasmedgeBin: "unused",
					cellTimeoutMs: 1000,
					workspaceWritePolicy,
				}),
		).toThrow("rustCell.workspaceWritePolicy");
	});

	it("uses the shared provisioner's immutable policy in the tool description", () => {
		const options = { cwd: "/unused", workspaceWritePolicy: "ro" as WorkspaceWritePolicy };
		const provisioner = new RustCellProvisioner(options);
		options.workspaceWritePolicy = "rw";
		expect(provisioner.workspaceWritePolicy).toBe("ro");
		expect(createRustToolDefinition("/unused", { provisioner, workspaceWritePolicy: "rw" }).description).toContain(
			"/workspace is read-only",
		);
	});

	it.each([undefined, "custom instructions"])("adapts the %s prompt to patch generation", (customPrompt) => {
		const prompt = buildSystemPrompt({ cwd: "/project", customPrompt, workspaceWritePolicy: "ro" });
		expect(prompt).toContain("Guest workspace policy: /workspace is read-only");
		expect(prompt).toContain("git apply from the host project directory");
		expect(prompt).not.toContain('edit_exact("/workspace/src/a.rs"');
		expect(prompt).not.toContain("reading, searching, and editing files");
		expect(prompt).toContain("host handlers retain host permissions");
	});

	it("retains the rw doctrine and does not offer unavailable host patch tools", () => {
		expect(buildSystemPrompt({ cwd: "/project" })).toContain('edit_exact("/workspace/src/a.rs"');
		const prompt = buildSystemPrompt({ cwd: "/project", workspaceWritePolicy: "ro", selectedTools: ["rust"] });
		expect(prompt).toContain("Return the patch to the caller");
		expect(prompt).not.toContain("git apply");
		expect(buildSystemPrompt({ cwd: "/project", workspaceWritePolicy: "ro", selectedTools: ["bash"] })).not.toContain(
			"Guest workspace policy",
		);
	});
});

describe("readonly workspace mount isolation", () => {
	it("rejects writable parents, identical paths, descendants, and symlinked roots", () => {
		const root = fixture();
		const project = join(root, "project");
		mkdirSync(project);
		const alias = join(root, "alias");
		symlinkSync(project, alias, "dir");
		for (const path of [root, project, join(project, "missing"), alias, join(alias, "missing")]) {
			for (const guestPath of ["/agent/state", "/scratch"]) {
				expect(() => assertReadonlyWorkspaceMounts(project, { [guestPath]: path }, {})).toThrow("overlaps");
			}
		}
		expect(() => assertReadonlyWorkspaceMounts(alias, { "/scratch": project }, {})).toThrow("overlaps");
		expect(() =>
			assertReadonlyWorkspaceMounts(project, { "/scratch": join(root, "project-extra") }, {}),
		).not.toThrow();
	});

	it("rejects ambiguous mount paths, including readonly and symlink targets", () => {
		const root = fixture();
		const colon = join(root, "with:colon");
		mkdirSync(colon);
		const alias = join(root, "alias");
		symlinkSync(colon, alias, "dir");
		for (const path of [colon, alias]) {
			expect(() => assertReadonlyWorkspaceMounts(path, {}, {})).toThrow("colons");
			expect(() => assertReadonlyWorkspaceMounts(join(root, "project"), { "/scratch": path }, {})).toThrow("colons");
			expect(() => assertReadonlyWorkspaceMounts(join(root, "project"), {}, { "/agent/lib": path })).toThrow(
				"colons",
			);
		}
	});

	it.each(["state", ".scratch"])("rejects a %s alias before writing or compiling source", async (mount) => {
		const root = fixture();
		const project = join(root, "project");
		const workspaceDir = join(root, "session");
		mkdirSync(project);
		mkdirSync(workspaceDir);
		symlinkSync(project, join(workspaceDir, mount), "dir");
		const runner = new CellRunner({
			cwd: project,
			workspaceDir,
			cargoBin: "must-not-run",
			wasmedgeBin: "must-not-run",
			cellTimeoutMs: 1000,
			workspaceWritePolicy: "ro",
		});
		await expect(runner.execute({ code: "fn main() {}" })).rejects.toThrow("overlaps the readonly /workspace");
		expect(existsSync(join(workspaceDir, "cell/src/main.rs"))).toBe(false);
	});
});

let toolchain: ToolchainInfo | undefined;
try {
	toolchain = resolveToolchain();
} catch {}

describe.skipIf(!toolchain || !isTemplateWarm())("workspace rights in real WasmEdge cells", () => {
	it("rechecks mount aliases after compilation, before guest execution", { timeout: 180_000 }, async () => {
		const root = fixture();
		const cwd = join(root, "project");
		mkdirSync(cwd);
		const workspaceDir = ensureWorkspaceAt(join(root, "session"));
		const runner = new CellRunner({
			cwd,
			workspaceDir,
			...toolchain!,
			cellTimeoutMs: 120_000,
			workspaceWritePolicy: "ro",
			validateSkills: async () => {
				symlinkSync(cwd, join(workspaceDir, ".scratch"), "dir");
			},
		});
		await expect(
			runner.execute({ code: 'fn main() { std::fs::write("/scratch/escaped.txt", "bad").unwrap(); }' }),
		).rejects.toThrow("overlaps the readonly /workspace");
		expect(existsSync(join(cwd, "escaped.txt"))).toBe(false);
	});

	it(
		"denies guest mutations while retaining reads, state, scratch, and declared library edits",
		{ timeout: 180_000 },
		async () => {
			const root = fixture();
			const cwd = join(root, "project");
			mkdirSync(cwd);
			mkdirSync(join(cwd, "empty"));
			writeFileSync(join(cwd, "source.txt"), "original");
			const workspaceDir = ensureWorkspaceAt(join(root, "session"));
			const options = {
				cwd,
				workspaceDir,
				...toolchain!,
				cellTimeoutMs: 120_000,
				workspaceWritePolicy: "ro" as WorkspaceWritePolicy,
			};
			const runner = new CellRunner(options);
			options.workspaceWritePolicy = "rw";
			const result = await runner.execute({
				lib: [{ path: "src/helpers/policy.rs", content: "pub fn answer() -> u32 { 42 }" }],
				code: `use agent_lib::prelude::*;
fn main() -> Result<()> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    assert_eq!(fs::read_to_string("/workspace/source.txt")?, "original");
    assert!(fs::read_dir("/workspace")?.count() >= 2);
    assert!(fs::write("/workspace/new.txt", "new").is_err());
    assert!(fs::write("/workspace/source.txt", "overwrite").is_err());
    assert!(OpenOptions::new().append(true).open("/workspace/source.txt").and_then(|mut file| file.write_all(b"append")).is_err());
    assert!(fs::File::open("/workspace/source.txt")?.set_len(0).is_err());
    assert!(OpenOptions::new().write(true).truncate(true).open("/workspace/source.txt").is_err());
    assert!(fs::rename("/workspace/source.txt", "/workspace/renamed.txt").is_err());
    assert!(fs::rename("/workspace/source.txt", "/scratch/moved.txt").is_err());
    assert!(fs::remove_file("/workspace/source.txt").is_err());
    assert!(fs::create_dir("/workspace/newdir").is_err());
    assert!(fs::remove_dir("/workspace/empty").is_err());
    assert!(fs::hard_link("/workspace/source.txt", "/scratch/alias.txt").is_err());
    fs::write("/scratch/patch.diff", "patch")?;
    fs::write("/agent/state/result.txt", "state")?;
    rlm::state::set("answer", &agent_lib::helpers::policy::answer())?;
    println!("read-only checks passed");
    Ok(())
}`,
			});
			expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
			expect(result.stdout).toContain("read-only checks passed");
			expect(readFileSync(join(cwd, "source.txt"), "utf-8")).toBe("original");
			expect(existsSync(join(cwd, "new.txt"))).toBe(false);
			expect(readFileSync(join(workspaceDir, "state/result.txt"), "utf-8")).toBe("state");
			const again = await runner.execute({
				code: `use agent_lib::prelude::*; fn main() -> Result<()> {
    assert_eq!(rlm::state::get::<u32>("answer")?, Some(42));
    assert!(std::fs::write("/workspace/source.txt", "retry").is_err());
    Ok(())
}`,
			});
			expect(again.status, again.compileDiagnostics ?? again.stderr).toBe("ok");
			const writable = new CellRunner({ ...options, workspaceWritePolicy: undefined });
			const edited = await writable.execute({
				code: 'fn main() { std::fs::write("/workspace/source.txt", "edited").unwrap(); }',
			});
			expect(edited.status, edited.stderr).toBe("ok");
			expect(readFileSync(join(cwd, "source.txt"), "utf-8")).toBe("edited");
		},
	);
});
