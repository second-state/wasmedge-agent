/** Runtime plumbing around the cell engine: template-dir resolution and the
 * concurrent-build gate (DESIGN.md §10). Pure host-side units — no toolchain
 * needed. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildConcurrency } from "../src/core/rust-cell/build-gate.js";
import { collectRuntimeChecks } from "../src/core/rust-cell/doctor.js";
import { ensureWorkspaceAt, resolveTemplateDir, templateCandidates } from "../src/core/rust-cell/workspace.js";

describe("templateCandidates", () => {
	// Both sides go through resolve(): templateCandidates returns resolve()
	// output, which on Windows carries the current drive that a bare join()
	// expectation lacks. Asserting by index rather than membership, because
	// resolveTemplateDir takes the first candidate that exists — order is the
	// contract, and a reordering that lets a wrong layout win first is exactly
	// the regression these cases exist to catch.

	// The bundle entry is the one that has already broken: `--dist` execs
	// dist/bundle/cli.js, so a bundler output-path change moves HERE and kills
	// the first `rust` cell of every --dist session while CI stays green.
	it("looks in the flattened bundle layout copy-assets writes into, first", () => {
		expect(templateCandidates(resolve("/pkg", "dist", "bundle"))[0]).toBe(
			resolve("/pkg", "dist", "wasmedge-agent-runtime", "template"),
		);
	});

	it("looks in the unbundled dist layout", () => {
		expect(templateCandidates(resolve("/pkg", "dist", "core", "rust-cell"))[1]).toBe(
			resolve("/pkg", "dist", "wasmedge-agent-runtime", "template"),
		);
	});

	it("covers the repo-root source layout", () => {
		expect(templateCandidates(resolve("/repo", "packages", "coding-agent", "src", "core", "rust-cell"))).toContain(
			resolve("/repo", "wasmedge-agent-runtime", "template"),
		);
	});

	// The repo-root entry climbs a fixed five levels, which only lands on the
	// repo root when `here` is the source tree. Evaluated from a dist layout the
	// same climb leaves the package altogether — on a checkout at ss/wasmedge-agent
	// it reaches ss/, where a sibling ss/wasmedge-agent-runtime would be adopted
	// as the guest workspace for every rust cell.
	it("keeps every candidate inside the package when running from a dist tree", () => {
		const pkg = resolve("/repo", "packages", "coding-agent");
		for (const candidate of templateCandidates(join(pkg, "dist", "bundle"))) {
			expect(candidate.startsWith(pkg + sep)).toBe(true);
		}
	});
});

describe("resolveTemplateDir", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		delete process.env.WASMEDGE_AGENT_TEMPLATE_DIR;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("honors WASMEDGE_AGENT_TEMPLATE_DIR when it points at a workspace", () => {
		const dir = mkdtempSync(join(tmpdir(), "template-override-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "Cargo.toml"), "[workspace]\n");
		process.env.WASMEDGE_AGENT_TEMPLATE_DIR = dir;
		expect(resolveTemplateDir()).toBe(dir);
	});

	it("rejects an override without a Cargo.toml instead of falling back", () => {
		const dir = mkdtempSync(join(tmpdir(), "template-override-"));
		tempDirs.push(dir);
		mkdirSync(join(dir, "empty"), { recursive: true });
		process.env.WASMEDGE_AGENT_TEMPLATE_DIR = join(dir, "empty");
		expect(() => resolveTemplateDir()).toThrow(/WASMEDGE_AGENT_TEMPLATE_DIR/);
	});

	/** Stage a checkout at <dir>/root whose package sits at the real depth, so a
	 * five-level climb out of dist/bundle lands on <dir> — the sibling-of-the-repo
	 * slot. Returns the bundle dir to resolve from. */
	function stageBundleLayout(dir: string): string {
		const bundle = join(dir, "root", "packages", "coding-agent", "dist", "bundle");
		mkdirSync(bundle, { recursive: true });
		return bundle;
	}

	function writeTemplate(at: string): string {
		mkdirSync(at, { recursive: true });
		writeFileSync(join(at, "Cargo.toml"), "[workspace]\n");
		return at;
	}

	// Pins the wrapper, not the candidate list: templateCandidates() can be
	// correct while resolveTemplateDir stops consulting it, and every from-source
	// and --dist session dies on its first rust cell with the suite still green.
	it("resolves the bundle layout's packaged template through the real search", () => {
		const dir = mkdtempSync(join(tmpdir(), "template-bundle-"));
		tempDirs.push(dir);
		const bundle = stageBundleLayout(dir);
		const template = writeTemplate(join(bundle, "..", "wasmedge-agent-runtime", "template"));
		expect(resolveTemplateDir(bundle)).toBe(resolve(template));
	});

	// The regression behind the fixed five-level climb: with no template inside
	// the package, a sibling checkout one level above the repo must not be
	// adopted as the guest workspace.
	it("fails instead of adopting a wasmedge-agent-runtime beside the repo", () => {
		const dir = mkdtempSync(join(tmpdir(), "template-sibling-"));
		tempDirs.push(dir);
		const bundle = stageBundleLayout(dir);
		writeTemplate(join(dir, "wasmedge-agent-runtime", "template"));
		expect(() => resolveTemplateDir(bundle)).toThrow(/template not found/);
	});
});

describe("ensureWorkspaceAt", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		delete process.env.WASMEDGE_AGENT_TEMPLATE_DIR;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function fakeTemplate(): string {
		const template = mkdtempSync(join(tmpdir(), "template-fake-"));
		tempDirs.push(template);
		writeFileSync(join(template, "Cargo.toml"), "[workspace]\n");
		mkdirSync(join(template, "cell"), { recursive: true });
		writeFileSync(join(template, "cell", "marker.rs"), "// marker\n");
		process.env.WASMEDGE_AGENT_TEMPLATE_DIR = template;
		return template;
	}

	it("clones the template when the dir does not exist yet", () => {
		fakeTemplate();
		const root = mkdtempSync(join(tmpdir(), "ws-root-"));
		tempDirs.push(root);
		const dir = join(root, "workspace");
		expect(ensureWorkspaceAt(dir)).toBe(dir);
		expect(existsSync(join(dir, "Cargo.toml"))).toBe(true);
		expect(existsSync(join(dir, "cell", "marker.rs"))).toBe(true);
	});

	it("clones the template into a pre-created empty dir (the mkdtemp fallback)", () => {
		fakeTemplate();
		const dir = mkdtempSync(join(tmpdir(), "ws-precreated-"));
		tempDirs.push(dir);
		ensureWorkspaceAt(dir);
		expect(existsSync(join(dir, "Cargo.toml"))).toBe(true);
		expect(existsSync(join(dir, "cell", "marker.rs"))).toBe(true);
	});

	it("preserves entries already present in the dir", () => {
		fakeTemplate();
		const dir = mkdtempSync(join(tmpdir(), "ws-precreated-"));
		tempDirs.push(dir);
		mkdirSync(join(dir, "skills"));
		writeFileSync(join(dir, "skills", "keep.txt"), "keep\n");
		ensureWorkspaceAt(dir);
		expect(existsSync(join(dir, "Cargo.toml"))).toBe(true);
		expect(readFileSync(join(dir, "skills", "keep.txt"), "utf-8")).toBe("keep\n");
	});
});

describe("resolveBuildConcurrency", () => {
	afterEach(() => {
		delete process.env.WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS;
	});

	it("defaults to a small bound and ignores malformed overrides", () => {
		const fallback = resolveBuildConcurrency();
		expect(fallback).toBeGreaterThanOrEqual(2);
		expect(fallback).toBeLessThanOrEqual(8);
		for (const raw of ["", "abc", "-2", "0", "00", "1.5"]) {
			process.env.WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS = raw;
			expect(resolveBuildConcurrency()).toBe(fallback);
		}
	});

	it("honors explicit overrides but clamps the ceiling", () => {
		process.env.WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS = "1";
		expect(resolveBuildConcurrency()).toBe(1);
		process.env.WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS = "12";
		expect(resolveBuildConcurrency()).toBe(12);
		process.env.WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS = "500";
		expect(resolveBuildConcurrency()).toBe(32);
	});
});

describe("collectRuntimeChecks", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		delete process.env.WASMEDGE_AGENT_TEMPLATE_DIR;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("reports an unvendored cold template without throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "doctor-template-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "Cargo.toml"), "[workspace]\n");
		process.env.WASMEDGE_AGENT_TEMPLATE_DIR = dir;

		const checks = collectRuntimeChecks();
		const byName = new Map(checks.map((check) => [check.name, check]));
		expect(byName.get("workspace template")).toMatchObject({ ok: true, detail: dir });
		expect(byName.get("template vendor")).toMatchObject({ ok: false });
		expect(byName.get("template build")).toMatchObject({ ok: false, detail: "cold" });
		// Toolchain checks exist regardless of what this machine has installed.
		expect(byName.has("cargo")).toBe(true);
		expect(byName.has("wasm32-wasip1 target")).toBe(true);
		expect(byName.has("wasmedge")).toBe(true);
	});

	it("degrades a broken template override to a failed check", () => {
		process.env.WASMEDGE_AGENT_TEMPLATE_DIR = join(tmpdir(), "doctor-missing-template");
		const checks = collectRuntimeChecks();
		const template = checks.find((check) => check.name === "workspace template");
		expect(template).toMatchObject({ ok: false });
		expect(checks.some((check) => check.name === "template vendor")).toBe(false);
	});
});
