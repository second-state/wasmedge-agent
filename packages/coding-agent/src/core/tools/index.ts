export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createRustTool,
	createRustToolDefinition,
	type RustToolDetails,
	type RustToolInput,
	type RustToolOptions,
} from "./rust.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.js";
import { createRustTool, createRustToolDefinition, type RustToolOptions } from "./rust.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "rust" | "bash";
export const allToolNames: Set<ToolName> = new Set(["rust", "bash"]);

export interface ToolsOptions {
	rust?: RustToolOptions;
	bash?: BashToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "rust":
			return createRustToolDefinition(cwd, options?.rust);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "rust":
			return createRustTool(cwd, options?.rust);
		case "bash":
			return createBashTool(cwd, options?.bash);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		rust: createRustToolDefinition(cwd, options?.rust),
		bash: createBashToolDefinition(cwd, options?.bash),
	};
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		rust: createRustTool(cwd, options?.rust),
		bash: createBashTool(cwd, options?.bash),
	};
}
