/** Shared types for the rust-cell runtime (DESIGN.md §2.2). */

import type { CellAttachment, CellDiffDisplay, CellSentAgentMessage } from "../host-bridge/types.js";
import type { BridgeServer } from "./bridge-server.js";

export interface LibFile {
	/** Path inside agent_lib/, e.g. "src/helpers/log_parse.rs". */
	path: string;
	/** Full file content (Rust source). */
	content: string;
}

export interface CellInput {
	code: string;
	lib?: LibFile[];
}

export type CellStatus = "ok" | "compile_error" | "error" | "timeout" | "aborted";

export interface CellResult {
	status: CellStatus;
	stdout: string;
	stderr: string;
	compileDiagnostics?: string;
	exitCode?: number;
	durationMs: number;
	compileMs: number;
	runMs: number;
	/** Lib files were declared, written, and compiled successfully. */
	libApplied: boolean;
	/** Declared lib files were reverted because the build failed. */
	libReverted: boolean;
	/** The readonly /agent/lib preopen failed to bind; the mount was dropped. */
	libReadonlyFallback: boolean;
	/** Rich output (host-synthesized lib diffs now; bridge emits from WP3). */
	diffs: CellDiffDisplay[];
	attachments: CellAttachment[];
	sentAgentMessages: CellSentAgentMessage[];
}

export interface RunnerOptions {
	/** Project directory mounted at /workspace. */
	cwd: string;
	/** Session workspace directory (the cargo workspace lives here). */
	workspaceDir: string;
	/** wasmedge binary path. */
	wasmedgeBin: string;
	/** cargo binary path. */
	cargoBin: string;
	/** Total per-cell budget in ms (compile + run). */
	cellTimeoutMs: number;
	/** Host bridge; when set, cells get RLM_BRIDGE_* env and rlm host calls work. */
	bridge?: BridgeServer;
	/** Extra WASI env vars for every cell (e.g. RLM_DEPTH). */
	cellEnv?: Record<string, string>;
}

export interface PerCallOptions {
	/** Streaming callback for live stdout/stderr chunks. */
	onChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
	/** Abort signal (user interrupt). */
	signal?: AbortSignal;
	/** Tool-call id; scopes the bridge handshake (RLM_CELL_ID). */
	cellId?: string;
}

export const MAX_OUTPUT_CHARS = 65_536;

export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[... output truncated at ${limit} chars ...]`;
}
