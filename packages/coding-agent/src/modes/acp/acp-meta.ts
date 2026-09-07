/**
 * Namespaced `_meta` payloads for wasmedge-agent capabilities that ACP has no
 * native concept for (rust cell semantics, RLM subagents, autonomous gates,
 * goals, heartbeats, continual harness state).
 *
 * ACP reserves `_meta` on capability objects, notifications, tool calls, and
 * content blocks precisely so agents can carry non-standard data. Vanilla ACP
 * clients ignore these keys; a wasmedge-agent-aware client (or the verifiers
 * harness) reads them. Never add non-standard fields to an ACP object root.
 */

/** Reverse-domain namespace for every wasmedge-agent `_meta` payload. */
export const WASMEDGE_AGENT_META_NAMESPACE = "ai.primeintellect.prime-agent";

export interface WasmEdgeAgentSubagentMeta {
	id: string;
	sessionName?: string;
	status: string;
	model?: string;
	depth?: number;
	tokenCount?: number;
	error?: string;
}

export interface WasmEdgeAgentAutonomousMeta {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	gateAttempt?: number;
	gateFailure?: string;
	limitReason?: string;
}

export interface WasmEdgeAgentRustAttachmentMeta {
	mimeType?: string;
	path?: string;
	bytes?: number;
}

export interface WasmEdgeAgentRustMeta {
	/** Media the cell loaded into context, as reported by the rust tool. */
	attachments?: WasmEdgeAgentRustAttachmentMeta[];
	/** Number of diffs the cell displayed. */
	diffCount?: number;
}

export interface WasmEdgeAgentGoalMeta {
	status: string;
	objective?: string;
	tokenBudget?: number;
	tokensUsed?: number;
}

export interface WasmEdgeAgentRefinementMeta {
	status: "complete" | "failed";
	summary?: string;
	changes?: string[];
	error?: string;
}

export interface WasmEdgeAgentAgentMessageMeta {
	toolCallId: string;
	target?: string;
	deliveryStatus?: string;
}

export interface WasmEdgeAgentCwdMeta {
	/** The cwd the client asked for. */
	requested: string;
	/** The cwd wasmedge-agent is actually running in, fixed at startup. */
	actual: string;
}

export interface WasmEdgeAgentSessionMeta {
	/** Present when a client-requested cwd differs from the agent's real cwd. */
	cwd?: WasmEdgeAgentCwdMeta;
	/** Set when the session's heartbeat or cron schedule changed. */
	heartbeatsChanged?: boolean;
	goal?: WasmEdgeAgentGoalMeta;
	refinement?: WasmEdgeAgentRefinementMeta;
	agentMessage?: WasmEdgeAgentAgentMessageMeta;
	sessionId?: string;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	compaction?: { tokensBefore?: number; summary?: string };
	subagents?: WasmEdgeAgentSubagentMeta[];
	autonomous?: WasmEdgeAgentAutonomousMeta;
	rust?: WasmEdgeAgentRustMeta;
}

/** Wrap a wasmedge-agent payload in its reverse-domain `_meta` envelope. */
export function wasmEdgeAgentMeta(payload: WasmEdgeAgentSessionMeta): Record<string, unknown> {
	return { [WASMEDGE_AGENT_META_NAMESPACE]: payload };
}
