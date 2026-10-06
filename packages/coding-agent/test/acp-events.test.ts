import { describe, expect, it } from "vitest";
import {
	type AcpEventMappingState,
	acpToolKind,
	acpUpdatesForSessionEvent,
	bashToolCallId,
} from "../src/modes/acp/acp-events.js";
import { WASMEDGE_AGENT_META_NAMESPACE } from "../src/modes/acp/acp-meta.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/types.js";

/** Real streaming shape: the discriminator is on the event, delta is a string. */
function assistantDelta(type: "text_delta" | "thinking_delta", delta: string): AgentConnectionSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content: [], usage: {} } as never,
		assistantMessageEvent: { type, contentIndex: 0, delta, partial: {} } as never,
	} as AgentConnectionSessionEvent;
}

describe("ACP session event mapping", () => {
	it("maps thinking deltas to agent_thought_chunk, not visible text", () => {
		const updates = acpUpdatesForSessionEvent(assistantDelta("thinking_delta", "reasoning"));
		expect(updates).toEqual([
			{
				sessionUpdate: "agent_thought_chunk",
				messageId: "wasmedge-agent-assistant-1",
				content: { type: "text", text: "reasoning" },
			},
		]);
	});

	it("assigns one message id per assistant message", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		const start = { type: "message_start", message } as AgentConnectionSessionEvent;
		const end = { type: "message_end", message } as AgentConnectionSessionEvent;

		expect(acpUpdatesForSessionEvent(start, state)).toEqual([]);
		expect(acpUpdatesForSessionEvent(assistantDelta("thinking_delta", "think"), state)[0]).toMatchObject({
			messageId: "wasmedge-agent-assistant-1",
		});
		expect(acpUpdatesForSessionEvent(assistantDelta("text_delta", "answer"), state)[0]).toMatchObject({
			messageId: "wasmedge-agent-assistant-1",
		});
		expect(acpUpdatesForSessionEvent(end, state)).toEqual([]);
		expect(state.activeAssistantMessageId).toBeUndefined();

		expect(acpUpdatesForSessionEvent(start, state)).toEqual([]);
		expect(acpUpdatesForSessionEvent(assistantDelta("text_delta", "next"), state)[0]).toMatchObject({
			messageId: "wasmedge-agent-assistant-2",
		});
	});

	it("ignores empty deltas and non-assistant messages", () => {
		expect(acpUpdatesForSessionEvent(assistantDelta("text_delta", ""))).toEqual([]);
		expect(
			acpUpdatesForSessionEvent({
				type: "message_update",
				message: { role: "user", content: "hi" } as never,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} } as never,
			} as AgentConnectionSessionEvent),
		).toEqual([]);
	});

	it("treats the rust cell as an execute tool call carrying its cell source", () => {
		expect(acpToolKind("rust")).toBe("execute");
		const updates = acpUpdatesForSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "rust",
			args: { code: "print(1)" },
		} as AgentConnectionSessionEvent);
		expect(updates).toEqual([
			{
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "Rust cell",
				kind: "execute",
				status: "in_progress",
				rawInput: { code: "print(1)" },
			},
		]);
	});

	it("carries rich rust cell output from the fields the tool actually reports", () => {
		// The rust tool reports media/diffs under `details`, so the mapping must
		// read those exact fields rather than an invented MIME bundle.
		const updates = acpUpdatesForSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "rust",
			result: {
				output: "done",
				details: {
					// CellAttachment carries base64 `data`, never a `bytes` field.
					attachments: [{ mimeType: "image/png", path: "/tmp/plot.png", data: "aGVsbG8=" }],
					diffs: [{ path: "a.ts" }],
				},
			},
			isError: false,
		} as AgentConnectionSessionEvent);
		expect(updates[0]).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "done" } }],
		});
		expect(updates[0]?._meta).toEqual({
			[WASMEDGE_AGENT_META_NAMESPACE]: {
				rust: {
					attachments: [{ mimeType: "image/png", path: "/tmp/plot.png", bytes: 5 }],
					diffCount: 1,
				},
			},
		});
	});

	it("omits rust cell rich metadata when the cell produced none", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-3",
			toolName: "rust",
			result: { output: "plain", details: { stdout: "plain" } },
			isError: false,
		} as AgentConnectionSessionEvent);
		expect(updates[0]).not.toHaveProperty("_meta");
	});

	it("marks failed tool calls as failed", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-2",
			toolName: "rust",
			result: "boom",
			isError: true,
		} as AgentConnectionSessionEvent);
		expect(updates[0]).toMatchObject({ status: "failed" });
	});

	it("keeps the bash tool-call id at its established wire value", () => {
		// The id crosses the protocol boundary and is what a client correlates
		// a bash call's updates by (rule R1). Every other assertion in this file
		// compares bashToolCallId() with itself, which would hold for any
		// spelling; this one names the value clients were given.
		expect(bashToolCallId("r1")).toBe("prime-agent-bash-r1");
		expect(bashToolCallId(undefined)).toBe("prime-agent-bash");
	});

	it("emits nothing for events ACP has no place for", () => {
		expect(acpUpdatesForSessionEvent({ type: "agent_start" } as AgentConnectionSessionEvent)).toEqual([]);
		expect(acpUpdatesForSessionEvent({ type: "recap_update", recap: "x" } as AgentConnectionSessionEvent)).toEqual(
			[],
		);
	});
});
