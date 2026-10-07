import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rustcVersion } from "../src/core/rust-cell/toolchain.js";
import { WorkspaceHistory } from "../src/core/rust-cell/workspace-history.js";
import { prepareVersionedWorkspace, WORKSPACE_VERSION_FILE } from "../src/core/rust-cell/workspace-version.js";

describe("workspace scaffold upgrades", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "workspace-version-"));
		dirs.push(root);
		const template = join(root, "template");
		const workspace = join(root, "workspace");
		const write = (base: string, path: string, text: string) => {
			mkdirSync(dirname(join(base, path)), { recursive: true });
			writeFileSync(join(base, path), text);
		};
		for (const [path, text] of Object.entries({
			"Cargo.toml": '[workspace]\nmembers = ["agent_lib", "cell", "rlm"]\n',
			"Cargo.lock": "lock-v1",
			".cargo/config.toml": "config-v1",
			"agent_lib/Cargo.toml": "lib-manifest-v1",
			"agent_lib/src/lib.rs": "library-v1",
			"agent_lib/src/prelude.rs": "prelude-v1",
			"agent_lib/src/helpers/mod.rs": "helpers-default",
			"agent_lib/src/skills/mod.rs": "skills-default",
			"cell/Cargo.toml": "cell-manifest-v1",
			"cell/src/main.rs": "fn main() {}",
			"rlm/Cargo.toml": "rlm-manifest-v1",
			"rlm/src/lib.rs": "runtime-v1",
			"target/cache": "cache-v1",
			"vendor/source": "vendor-v1",
		}))
			write(template, path, text);
		const configure = vi.fn();
		const validate = vi.fn();
		const options = {
			templateDir: template,
			rustcVersion: "rustc-v1",
			wasmedgeVersion: "wasmedge-v1",
			configure,
			validate,
		};
		const prepare = () => prepareVersionedWorkspace(workspace, options);
		const read = (path: string) => readFileSync(join(workspace, path), "utf-8");
		const marker = () => JSON.parse(read(WORKSPACE_VERSION_FILE));
		return {
			root,
			template,
			workspace,
			write,
			options,
			prepare,
			read,
			marker,
			transaction: join(root, ".workspace.upgrade"),
		};
	}

	it("marks fresh workspaces and leaves matching versions untouched", () => {
		const f = fixture();
		f.prepare();
		const marker = f.read(WORKSPACE_VERSION_FILE);
		f.write(f.workspace, "agent_lib/src/helpers/custom.rs", "custom");
		f.prepare();
		expect(f.read(WORKSPACE_VERSION_FILE)).toBe(marker);
		expect(f.marker()).toMatchObject({ schema: 1, rustcVersion: "rustc-v1", wasmedgeVersion: "wasmedge-v1" });
		expect(f.options.validate).not.toHaveBeenCalled();
		expect(f.read("agent_lib/src/helpers/custom.rs")).toBe("custom");
	});

	it("updates runtime and untouched defaults while preserving all user assets and Git history", async () => {
		const f = fixture();
		f.write(f.template, "agent_lib/src/obsolete.rs", "obsolete");
		f.write(f.template, "agent_lib/src/deleted.rs", "deleted by user");
		f.write(f.template, "rlm/src/obsolete.rs", "old runtime file");
		f.prepare();
		const old = f.marker();
		for (const path of [
			"agent_lib/src/prelude.rs",
			"agent_lib/src/helpers/mod.rs",
			"agent_lib/src/helpers/custom.rs",
			"agent_lib/src/extra.rs",
			"cell/src/main.rs",
			"state/state.json",
			"state/blobs/data",
			"notes.txt",
		]) {
			f.write(f.workspace, path, `user ${path}`);
		}
		rmSync(join(f.workspace, "agent_lib/src/deleted.rs"));
		f.write(f.root, "skill/Cargo.toml", "skill manifest");
		mkdirSync(join(f.workspace, "skills"));
		symlinkSync(join(f.root, "skill"), join(f.workspace, "skills/linked"));
		await new WorkspaceHistory(f.workspace).ensure();
		const head = () => execFileSync("git", ["-C", f.workspace, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
		const beforeHead = head();
		for (const path of [
			"Cargo.lock",
			"agent_lib/src/lib.rs",
			"agent_lib/src/prelude.rs",
			"rlm/src/lib.rs",
			"target/cache",
			"vendor/source",
		])
			f.write(f.template, path, `new ${path}`);
		rmSync(join(f.template, "rlm/src/obsolete.rs"));
		rmSync(join(f.template, "agent_lib/src/obsolete.rs"));
		f.options.validate.mockImplementation((staged) => {
			expect(f.read("rlm/src/lib.rs")).toBe("runtime-v1");
			expect(readFileSync(join(staged, "rlm/src/lib.rs"), "utf-8")).toBe("new rlm/src/lib.rs");
		});
		f.prepare();
		expect(f.options.configure).toHaveBeenCalledOnce();
		expect(f.options.validate).toHaveBeenCalledOnce();
		expect(f.read("agent_lib/src/lib.rs")).toBe("new agent_lib/src/lib.rs");
		for (const path of [
			"agent_lib/src/prelude.rs",
			"agent_lib/src/helpers/mod.rs",
			"agent_lib/src/helpers/custom.rs",
			"agent_lib/src/extra.rs",
			"cell/src/main.rs",
			"state/state.json",
			"state/blobs/data",
			"notes.txt",
		])
			expect(f.read(path)).toBe(`user ${path}`);
		for (const path of ["rlm/src/obsolete.rs", "agent_lib/src/obsolete.rs", "agent_lib/src/deleted.rs"])
			expect(existsSync(join(f.workspace, path))).toBe(false);
		expect(f.read("skills/linked/Cargo.toml")).toBe("skill manifest");
		expect(head()).toBe(beforeHead);
		expect(f.marker().templateHash).not.toBe(old.templateHash);
		expect(f.marker().dependencyHash).not.toBe(old.dependencyHash);
		expect(f.read("vendor/source")).toBe("new vendor/source");
		expect(existsSync(f.transaction)).toBe(false);
	});

	it.each(["rustcVersion", "wasmedgeVersion"] as const)("revalidates a changed %s", (field) => {
		const f = fixture();
		f.prepare();
		f.options[field] = "v2";
		f.prepare();
		expect(f.options.validate).toHaveBeenCalledOnce();
		expect(f.marker()[field]).toBe("v2");
	});

	it("migrates unmarked workspaces conservatively, retaining legacy library sources", () => {
		const f = fixture();
		f.prepare();
		rmSync(join(f.workspace, WORKSPACE_VERSION_FILE));
		f.write(f.template, "agent_lib/src/prelude.rs", "new prelude");
		f.write(f.template, "rlm/src/lib.rs", "new runtime");
		f.prepare();
		expect(f.read("agent_lib/src/prelude.rs")).toBe("prelude-v1");
		expect(f.read("rlm/src/lib.rs")).toBe("new runtime");
		expect(f.options.validate).toHaveBeenCalledOnce();
	});

	it("keeps the original tree and marker after a failed build, then permits retry", () => {
		const f = fixture();
		f.prepare();
		const marker = f.read(WORKSPACE_VERSION_FILE);
		f.write(f.workspace, "state/state.json", "precious");
		f.write(f.template, "rlm/src/lib.rs", "new runtime");
		f.options.validate.mockImplementationOnce(() => {
			throw new Error("compiler diagnostics");
		});
		expect(f.prepare).toThrow(/original workspace retained.*compiler diagnostics/);
		expect(f.read(WORKSPACE_VERSION_FILE)).toBe(marker);
		expect(f.read("rlm/src/lib.rs")).toBe("runtime-v1");
		expect(f.read("state/state.json")).toBe("precious");
		expect(existsSync(f.transaction)).toBe(false);
		f.prepare();
		expect(f.read("rlm/src/lib.rs")).toBe("new runtime");
	});

	it("rejects an invalid marker without replacing source", () => {
		const f = fixture();
		f.prepare();
		f.write(f.workspace, WORKSPACE_VERSION_FILE, '{"schema":2}');
		expect(f.prepare).toThrow(/Cannot read/);
		expect(f.read(WORKSPACE_VERSION_FILE)).toBe('{"schema":2}');
	});

	it.each([false, true])("recovers interrupted publication (new workspace published: %s)", (published) => {
		const f = fixture();
		f.prepare();
		mkdirSync(f.transaction);
		f.write(f.transaction, "owner.json", JSON.stringify({ pid: 0 }));
		renameSync(f.workspace, join(f.transaction, "previous"));
		if (published) {
			cpSync(join(f.transaction, "previous"), f.workspace, { recursive: true });
			f.write(f.workspace, "state/state.json", "new state");
		}
		f.prepare();
		expect(f.read("rlm/src/lib.rs")).toBe("runtime-v1");
		if (published) expect(f.read("state/state.json")).toBe("new state");
		expect(existsSync(f.transaction)).toBe(false);
	});

	it("does not steal an active upgrade", () => {
		const f = fixture();
		f.prepare();
		mkdirSync(f.transaction);
		f.write(f.transaction, "owner.json", JSON.stringify({ pid: process.pid }));
		expect(f.prepare).toThrow(/already running/);
		expect(existsSync(f.transaction)).toBe(true);
	});

	it("carries an older inherited seed through the same upgrade", () => {
		const f = fixture();
		f.prepare();
		f.write(f.workspace, "agent_lib/src/helpers/custom.rs", "inherited helper");
		renameSync(f.workspace, join(f.root, "seed"));
		f.write(f.template, "rlm/src/lib.rs", "new runtime");
		prepareVersionedWorkspace(f.workspace, { ...f.options, initialWorkspaceDir: join(f.root, "seed") });
		expect(f.read("agent_lib/src/helpers/custom.rs")).toBe("inherited helper");
		expect(f.read("rlm/src/lib.rs")).toBe("new runtime");
		expect(readFileSync(join(f.root, "seed/rlm/src/lib.rs"), "utf-8")).toBe("runtime-v1");
	});

	it.each(["agent_lib/src", "skills"])("does not write through symlinked %s into external data", (path) => {
		const f = fixture();
		f.prepare();
		f.write(f.workspace, `${path}/keep.txt`, "external data");
		const external = join(f.root, "external");
		renameSync(join(f.workspace, path), external);
		symlinkSync(external, join(f.workspace, path));
		f.write(f.template, "agent_lib/src/lib.rs", "new library");
		expect(f.prepare).toThrow(/symlinked scaffold/);
		expect(readFileSync(join(external, "keep.txt"), "utf-8")).toBe("external data");
	});

	it("reads compiler identity beside Cargo and honors RUSTC", () => {
		const f = fixture();
		const compiler = join(f.root, "rustc");
		writeFileSync(compiler, '#!/bin/sh\necho "selected compiler"\n', { mode: 0o755 });
		vi.stubEnv("RUSTC", undefined);
		expect(rustcVersion(join(f.root, "cargo"), f.root)).toBe("selected compiler");
		vi.stubEnv("RUSTC", join(f.root, "override"));
		writeFileSync(join(f.root, "override"), '#!/bin/sh\necho "override compiler"\n', { mode: 0o755 });
		expect(rustcVersion(join(f.root, "cargo"), f.root)).toBe("override compiler");
	});
});
