/** The `rust` cell tool: one complete Rust program per call, compiled to
 * wasm32-wasip1 and run in the WasmEdge sandbox (DESIGN.md §2.5). Replaces the
 * `ipython` tool as the model's control environment. */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import type { CellInput, CellResult } from "../rust-cell/index.js";
import { composeToolText, RustCellProvisioner } from "../rust-cell/index.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const rustSchema = Type.Object({
	code: Type.String({
		description:
			"A complete Rust program: `use agent_lib::prelude::*;` then `fn main() -> Result<()>`. " +
			"Compile errors are returned as feedback; fix and resubmit the full program.",
	}),
	lib: Type.Optional(
		Type.Array(
			Type.Object({
				path: Type.String({
					description: "File path inside agent_lib/, e.g. src/helpers/log_parse.rs",
				}),
				content: Type.String({ description: "Full file content (Rust source)" }),
			}),
			{
				description:
					"Optional: files to write into your persistent agent_lib crate before compiling. " +
					"Compiled together with the cell; if the library fails to build, the files are " +
					"reverted and the cell does not run.",
			},
		),
	),
});

export type RustToolInput = CellInput;
export type RustToolDetails = CellResult | { status: "starting" };

export interface RustToolOptions {
	/** Persistent workspace dir (session artifacts); temp dir when omitted. */
	workspaceDir?: string;
	/** Per-cell budget in ms (compile + run). */
	cellTimeoutMs?: number;
	/** Shared provisioner owning the runtime lifecycle. When provided, the remaining options are ignored. */
	provisioner?: RustCellProvisioner;
}

function setWorkingMessage(ctx: ExtensionContext | undefined, message?: string): void {
	try {
		ctx?.ui.setWorkingMessage(message);
	} catch {
		// UI is optional in headless contexts
	}
}

export function createRustToolDefinition(
	cwd: string,
	options?: RustToolOptions,
): ToolDefinition<typeof rustSchema, RustToolDetails> {
	const provisioner =
		options?.provisioner ??
		new RustCellProvisioner({
			cwd,
			workspaceDir: options?.workspaceDir,
			cellTimeoutMs: options?.cellTimeoutMs,
		});

	return {
		name: "rust",
		label: "rust",
		description:
			"Execute a complete Rust program (a 'cell') compiled to wasm32-wasip1 and run in a " +
			"WasmEdge sandbox. Cells are not REPL fragments: variables do not persist between " +
			"cells. Persistent layers instead: rlm::state (key-value), the agent_lib crate " +
			"(extend it by passing lib files alongside your code), and files. Project imports, " +
			"tests, scripts, CLIs, and dependency checks must run through the project's own " +
			"environment via the bash tool.",
		promptSnippet: "rust - sandboxed Rust cells with explicit persistence (rlm::state, agent_lib)",
		// Cells share one workspace and one target dir — never two cells at once.
		executionMode: "sequential",
		parameters: rustSchema,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			let hasWorkingMessage = false;
			const setToolWorkingMessage = (message?: string) => {
				setWorkingMessage(ctx, message);
				hasWorkingMessage = message !== undefined;
			};
			try {
				const runner = await provisioner.ensure((message) => {
					setToolWorkingMessage(message);
					onUpdate?.({
						content: [{ type: "text", text: message }],
						details: { status: "starting" },
					});
				});
				const result = await runner.execute(params as CellInput, {
					signal,
					cellId: toolCallId,
					onChunk: (chunk) => {
						onUpdate?.({
							content: [{ type: "text", text: chunk }],
							details: { status: "starting" },
						});
					},
				});
				const text = composeToolText(result);
				// Attachments become image content blocks so the TUI renders them
				// and ACP forwards them; details keeps the structured copy.
				const images = result.attachments
					.filter((attachment) => attachment.mimeType.startsWith("image/"))
					.map((attachment) => ({
						type: "image" as const,
						data: attachment.data,
						mimeType: attachment.mimeType,
					}));
				return {
					content: [{ type: "text", text: text || "(no output)" }, ...images],
					details: result,
					isError: result.status !== "ok",
				};
			} finally {
				if (hasWorkingMessage) {
					setToolWorkingMessage();
				}
			}
		},
	};
}

export function createRustTool(cwd: string, options?: RustToolOptions): AgentTool<typeof rustSchema> {
	return wrapToolDefinition(createRustToolDefinition(cwd, options));
}
