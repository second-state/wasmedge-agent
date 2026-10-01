import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { isTemplateWarm, resolveToolchain } from "../../../src/core/rust-cell/toolchain.js";
import { loadSkillsFromDir } from "../../../src/core/skills.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("refinement skill gate (real WasmEdge, faux provider)", () => {
	let harness: Harness | undefined;
	let root: string | undefined;
	afterEach(async () => {
		await harness?.session.disposeAsync();
		harness?.cleanup();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("registers a tested crate and preserves the entry when an updated test fails", { timeout: 300_000 }, async () => {
		root = mkdtempSync(join(tmpdir(), "refine-skill-suite-"));
		const crate = join(root, "example");
		mkdirSync(join(crate, "src"), { recursive: true });
		writeFileSync(join(crate, "SKILL.md"), "---\nname: example\ndescription: Test example\n---\nCall run().\n");
		writeFileSync(join(crate, "Cargo.toml"), '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2021"\n');
		const source = join(crate, "src/lib.rs");
		writeFileSync(
			source,
			`pub fn run() -> u32 { 42 }
#[test] fn answer() {
    assert_eq!(run(), 42);
    assert_eq!(std::arch::wasm32::memory_grow::<0>(128), usize::MAX);
}`,
		);
		const loaded = loadSkillsFromDir({ dir: root, source: "project" });
		expect(loaded.skills).toHaveLength(1);
		harness = await createHarness({
			persistSession: true,
			isolateSessionStorage: true,
			settings: { rustCell: { cellTimeoutMs: 240_000, cellGasLimit: 1_000_000, cellMemoryPageLimit: 128 } },
			resourceLoader: createTestResourceLoader({ skills: loaded.skills }),
		});
		const h = harness;
		h.setResponses([fauxAssistantMessage("ready")]);
		await h.session.prompt("Remember the tested example skill");
		const propose = (action: string) =>
			fauxAssistantMessage(
				JSON.stringify({
					summary: "Register example",
					rationale: "Reusable helper",
					expectedOutcome: "Reuse the answer",
					edits: [
						{
							action,
							kind: "skill",
							id: "local:example",
							title: "Example",
							content: "Call run()",
							reference: { type: "rust", use: "agent_lib::skills::example", callable: "run" },
							arguments: {},
						},
					],
				}),
			);
		h.setResponses([propose("create")]);
		const created = await h.session.refine();
		expect(created.appliedEdits[0], JSON.stringify(created)).toMatchObject({ applied: true, id: "example" });
		const before = JSON.parse(readFileSync(created.harnessStatePath, "utf8")).entries.skill.example;
		writeFileSync(source, "pub fn run() -> u32 { 43 }\n#[test] fn answer() { assert_eq!(run(), 42); }");
		h.setResponses([propose("update")]);
		const updated = await h.session.refine();
		expect(updated.appliedEdits[0]).toMatchObject({
			applied: false,
			error: expect.stringContaining("sandboxed skill tests failed"),
		});
		expect(JSON.parse(readFileSync(created.harnessStatePath, "utf8")).entries.skill.example).toEqual(before);
		writeFileSync(
			source,
			`pub fn run() -> u32 { 42 }
#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" { fn sock_open(family: u32, kind: u32, fd: *mut u32) -> u32; }
#[test] fn network() {
    let mut fd = 0;
    unsafe { std::hint::black_box(sock_open(1, 1, &mut fd)); }
}`,
		);
		h.setResponses([propose("update")]);
		const network = await h.session.refine();
		expect(network.appliedEdits[0]).toMatchObject({
			applied: false,
			error: expect.stringContaining("skill test import not allowed"),
		});
		expect(JSON.parse(readFileSync(created.harnessStatePath, "utf8")).entries.skill.example).toEqual(before);
		writeFileSync(source, "pub fn run() -> u32 { 42 }\n#[test] fn hangs() { loop { std::hint::black_box(1); } }");
		h.setResponses([propose("update")]);
		const exhausted = await h.session.refine();
		expect(exhausted.appliedEdits[0]).toMatchObject({
			applied: false,
			error: expect.stringMatching(/cost (?:exceeded limit|limit exceeded)/i),
		});
		expect(JSON.parse(readFileSync(created.harnessStatePath, "utf8")).entries.skill.example).toEqual(before);
	});
});
