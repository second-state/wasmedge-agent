/** The suite layer for the cell runtime (DESIGN.md §9): scripted faux-provider
 * replies drive the REAL rust tool through AgentSession — no model tokens, but
 * a genuine compile + WasmEdge run, tool-result composition, and cross-cell
 * workspace persistence. Skipped without the toolchain + warm template. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo } from "../../../src/core/rust-cell/toolchain.js";
import { createRustTool } from "../../../src/core/tools/rust.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

let toolchain: ToolchainInfo | undefined;
try {
	toolchain = resolveToolchain();
} catch {
	toolchain = undefined;
}
const available = toolchain !== undefined && isTemplateWarm();

const WRITE_CELL = `use agent_lib::prelude::*;

fn main() -> Result<()> {
    write_file("/workspace/note.txt", "from-cell-one")?;
    rlm::state::set("counter", &41_u32)?;
    println!("wrote the note");
    Ok(())
}
`;

const READ_CELL = `use agent_lib::prelude::*;

fn main() -> Result<()> {
    let counter: Option<u32> = rlm::state::get("counter")?;
    println!("counter={}", counter.unwrap_or(0) + 1);
    Ok(())
}
`;

const BROKEN_CELL = `fn main() { let x: u32 = "nope"; }
`;

function toolResultTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => getMessageText(message));
}

describe.skipIf(!available)("AgentSession drives the real rust tool (suite)", () => {
	const tempDirs: string[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("runs scripted cells: side effects, persistence, and compile errors", { timeout: 300_000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "suite-rust-"));
		tempDirs.push(root);
		const projectDir = join(root, "project");
		mkdirSync(projectDir, { recursive: true });

		const harness = await createHarness({
			tools: [createRustTool(projectDir, { workspaceDir: join(root, "workspace") })],
		});
		harnesses.push(harness);

		// Turn 1: the scripted model writes a file and persists state.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("rust", { code: WRITE_CELL }), { stopReason: "toolUse" }),
			fauxAssistantMessage("noted the file"),
		]);
		await harness.session.prompt("write the note");

		expect(toolResultTexts(harness).at(-1)).toContain("wrote the note");
		expect(existsSync(join(projectDir, "note.txt"))).toBe(true);
		expect(readFileSync(join(projectDir, "note.txt"), "utf-8")).toBe("from-cell-one");

		// Turn 2: a later cell sees the persisted state (workspace continuity).
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("rust", { code: READ_CELL }), { stopReason: "toolUse" }),
			fauxAssistantMessage("read the counter"),
		]);
		await harness.session.prompt("read the counter back");

		expect(toolResultTexts(harness).at(-1)).toContain("counter=42");

		// Turn 3: a compile error comes back as diagnostics in the tool
		// result, and the session keeps going.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("rust", { code: BROKEN_CELL }), { stopReason: "toolUse" }),
			fauxAssistantMessage("that one failed to build"),
		]);
		await harness.session.prompt("run a broken cell");

		const failureText = toolResultTexts(harness).at(-1) ?? "";
		expect(failureText).toContain("mismatched types");
		expect(harness.session.messages.at(-1)?.role).toBe("assistant");
	});
});
