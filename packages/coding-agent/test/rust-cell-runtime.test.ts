/** Runtime plumbing around the cell engine: template-dir resolution and the
 * concurrent-build gate (DESIGN.md §10). Pure host-side units — no toolchain
 * needed. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
