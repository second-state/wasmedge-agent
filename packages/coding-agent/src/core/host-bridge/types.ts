/** Runtime-neutral host-bridge and rich-output types.
 *
 * These outlive the IPython kernel they were born in (DESIGN.md §2.7/§2.9):
 * host request handlers are the authoritative host-side surface the rust-cell
 * bridge dispatches into, and the display types are the wire shapes the TUI
 * and session events already understand. */

/**
 * Handles one typed request from guest code (e.g. "rlm.run", "goal.complete").
 * The returned record is sent back verbatim as the reply payload.
 */
export type HostRequestHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Host request handlers keyed by request type. */
export type HostRequestHandlers = Record<string, HostRequestHandler>;

/** One file edit surfaced as rich output. */
export interface KernelDiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	/** 1-based line where `oldStr` begins in the file, for absolute line numbers. */
	startLine?: number;
}

/** One media attachment surfaced as rich output. */
export interface KernelAttachment {
	mimeType: string;
	/** base64-encoded bytes. */
	data: string;
	/** Source path, surfaced to the TUI renderer. */
	path?: string;
}

/** Receipt for an agent message sent from guest code. */
export interface KernelSentAgentMessage {
	id: string;
	message: string;
	deliveryStatus: "delivered" | "queued";
	receiverRole?: "parent" | "sibling" | "child";
	target: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
	};
}
