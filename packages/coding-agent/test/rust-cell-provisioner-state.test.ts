import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";

describe("unstarted provisioner state listing", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function workspace(): string {
		const dir = mkdtempSync(join(tmpdir(), "rust-provisioner-state-"));
		dirs.push(dir);
		mkdirSync(join(dir, "agent_lib/src"), { recursive: true });
		mkdirSync(join(dir, "state/blobs"), { recursive: true });
		writeFileSync(join(dir, "Cargo.toml"), "[workspace]\n");
		writeFileSync(join(dir, "agent_lib/src/lib.rs"), "pub struct Saved; pub fn reuse() {}");
		writeFileSync(join(dir, "state/state.json"), JSON.stringify({ checkpoint: 1 }));
		writeFileSync(join(dir, "state/blobs/result.bin"), "result");
		return dir;
	}

	it("reads an existing configured workspace without provisioning and refreshes its listing", () => {
		const dir = workspace();
		const files = readdirSync(dir, { recursive: true });
		const provisioner = new RustCellProvisioner({ cwd: dir, workspaceDir: dir });
		expect(provisioner.hasWorkspace).toBe(true);
		expect(provisioner.listState()).toEqual({
			stateKeys: ["checkpoint"],
			blobNames: ["result.bin"],
			libFunctions: ["reuse"],
			libTypes: ["Saved"],
		});
		expect(provisioner.hasRunner).toBe(false);
		expect(provisioner.workspaceDir).toBeUndefined();
		expect(provisioner.toolchain).toBeUndefined();
		expect(provisioner.bridge).toBeUndefined();
		expect(readdirSync(dir, { recursive: true })).toEqual(files);

		writeFileSync(join(dir, "state/state.json"), JSON.stringify({ updated: true }));
		expect(provisioner.listState().stateKeys).toEqual(["updated"]);
	});

	it("does not create a missing workspace or expose the parent seed as child state", () => {
		const seed = workspace();
		const child = join(seed, "child");
		const provisioner = new RustCellProvisioner({ cwd: seed, workspaceDir: child, initialWorkspaceDir: seed });
		expect(provisioner.hasWorkspace).toBe(false);
		expect(provisioner.listState()).toEqual({ stateKeys: [], blobNames: [], libFunctions: [], libTypes: [] });
		expect(existsSync(child)).toBe(false);
	});

	it("does not treat an artifact directory without a workspace manifest as a restored workspace", () => {
		const dir = workspace();
		rmSync(join(dir, "Cargo.toml"));
		const provisioner = new RustCellProvisioner({ cwd: dir, workspaceDir: dir });
		expect(provisioner.hasWorkspace).toBe(false);
		expect(provisioner.listState()).toEqual({ stateKeys: [], blobNames: [], libFunctions: [], libTypes: [] });
	});
});
