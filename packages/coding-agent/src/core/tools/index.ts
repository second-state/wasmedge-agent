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
import { type BashToolOptions, createBashToolDefinition } from "./bash.js";
import { createRustToolDefinition, type RustToolOptions } from "./rust.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "rust" | "bash";
export const allToolNames: Set<ToolName> = new Set(["rust", "bash"]);

export interface ToolsOptions {
	rust?: RustToolOptions;
	bash?: BashToolOptions;
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		rust: createRustToolDefinition(cwd, options?.rust),
		bash: createBashToolDefinition(cwd, options?.bash),
	};
}
