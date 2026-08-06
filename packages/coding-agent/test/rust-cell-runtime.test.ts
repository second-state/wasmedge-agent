/** Runtime plumbing around the cell engine: template-dir resolution and the
 * concurrent-build gate (DESIGN.md §10). Pure host-side units — no toolchain
 * needed. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildConcurrency } from "../src/core/rust-cell/build-gate.js";
import { resolveTemplateDir } from "../src/core/rust-cell/workspace.js";

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
