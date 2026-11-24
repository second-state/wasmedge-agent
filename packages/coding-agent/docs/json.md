# JSON Event Stream Mode

```bash
wasmedge-agent --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating WasmEdge Agent into other tools or custom UIs.

## Event Types

Session events report scheduling, compaction and retries.

| Event | Fields |
|---|---|
| `session_action_update` | `actions` |
| `compaction_start` | `reason` |
| `compaction_end` | `reason`, `result`, `aborted`, `willRetry`, `errorMessage` |
| `auto_retry_start` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` |
| `auto_retry_end` | `success`, `attempt`, `finalError` |

`session_action_update` emits literal queued actions separately from active scheduler work whenever either projection changes. `compaction_start` and `compaction_end` cover both manual and automatic compaction.

The [Rust event enum](../../../crates/pa-agent/src/types.rs) defines the base events.

| Event | Fields |
|---|---|
| `agent_start` | — |
| `agent_end` | `messages` |
| `turn_start` | — |
| `turn_end` | `message`, `toolResults` |
| `message_start` | `message` |
| `message_update` | `message`, `assistantMessageEvent` |
| `message_end` | `message` |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult` |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError` |

## Message Types

Base messages from [`packages/ai/src/types.ts`](../../ai/src/types.ts):
- `UserMessage` (line 134)
- `AssistantMessage` (line 140)
- `ToolResultMessage` (line 152)

Extended messages from [`packages/coding-agent/src/core/messages.ts`](../src/core/messages.ts):
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

## Example

```bash
wasmedge-agent --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
