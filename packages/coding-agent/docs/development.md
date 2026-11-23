# Development

See the repository [AGENTS.md](../../../AGENTS.md) for the current contribution rules and required validation.

## Setup

Install Rust, its `wasm32-wasip1` target, Git and WasmEdge. From the repository root:

```sh
rustup target add wasm32-wasip1
cargo build --release --locked --bin wasmedge-agent
./wasmedge-agent.sh --dist doctor --fix
./wasmedge-agent.sh --dist
```

The launcher preserves the caller's working directory. The public embedding library is documented in the [Rust SDK guide](sdk.md).

## Local Configuration

User configuration lives under `~/.wasmedge-agent/`. Project-local settings, prompts, themes, extensions, skills, and system-prompt files live under `.wasmedge-agent/` in the project root. Override the user config directory with `WASMEDGE_AGENT_CODING_AGENT_DIR` and the session directory with `WASMEDGE_AGENT_SESSION_DIR`.

Use an isolated config directory when manually exercising daemon behavior so development sessions do not collide with normal sessions:

```bash
WASMEDGE_AGENT_CODING_AGENT_DIR=/tmp/wasmedge-agent-dev /path/to/wasmedge-agent/wasmedge-agent.sh
```

## Daemon Protocol Changes

Classify every daemon command, event, or response-shape change as backward-compatible, capability-gated, or incompatible. Optional behavior must be negotiated and degrade locally. Follow the protocol-version, schema-revision, compatibility-map, and cross-version test requirements in the root `AGENTS.md` before changing the wire contract.

## Package assets

The native executable finds adjacent release assets. In a checkout the launcher sets the package directory. The release packager copies the root `catalog/`, `skills/` and `wasmedge-agent-runtime/` directories.

## Debugging

The hidden `/debug` command writes `~/.wasmedge-agent/wasmedge-agent-debug.log` with rendered TUI lines, their visible widths, and the current agent messages. Daemon, worker, client, and provider diagnostic logs live under `~/.wasmedge-agent/logs/`.

### Request timing

When the UI sits in `Waiting` for a long time before the first model output appears, request timing shows what that wait is made of. Enable it with `PI_REQUEST_TIMING=1` in the environment (restart the daemon so worker processes inherit it) or `"requestTiming": true` in settings.json (applies to sessions opened after the change). Each agent-loop provider request then logs its phase timeline to `~/.wasmedge-agent/logs/agent.jsonl` under the component `coding-agent.request-timing`. One-shot completion calls outside the agent loop (compaction, branch-summary, and refinement requests) use a separate path and are not logged:

```bash
grep '"coding-agent.request-timing"' ~/.wasmedge-agent/logs/agent.jsonl | tail -5
```

Phases per request, in order. Each entry carries the gap it closed (`phaseMs`) and the elapsed time since turn dispatch (`totalMs`); `prompt-built` fires before the request has model or session fields, so correlate it with the later entries by `requestSeq`. If a provider never reports a phase (for example `request-sent` when no payload hook runs), that delta is simply omitted:

| Phase | Meaning | A long gap here means |
|-------|---------|----------------------|
| `prompt-built` | Turn dispatched, prompt message array built | Client-side prompt build is slow |
| `request-sent` | Payload handed to the provider client | Client-side request build (auth, params, extension payload hooks, the `requestBytes` serialization) is slow |
| `first-byte` | HTTP response headers received (`requestBytes`: serialized request body size in UTF-8 bytes) | Upload of the request body plus provider TTFB (prefill, prompt-cache miss, queueing) |
| `first-token` | First streamed content block (what clears `Waiting`) | Stream parse delay; usually near zero |
| `stream-done` | Terminal event, with the summary below | Slow full stream |

The final entry (`msg: "request timing summary"`) carries every delta it measured: `phases.dispatchToPromptBuiltMs`, `promptBuiltToRequestSentMs`, `requestSentToFirstByteMs`, `firstByteToFirstTokenMs`, `firstTokenToStreamDoneMs`, plus `contextEntries`, `requestBytes`, `sessionId`, the final `usage`, and an `outcome` (`done`, `aborted` for an early stop such as a user cancel, or `failed` when the provider failed before or during the stream).

Reading it for a slow large-context turn:

- Large `promptBuiltToRequestSentMs` — the client is slow. Both phases before the request leaves are client-side.
- Large `requestSentToFirstByteMs` with a normal TTFT on the inference dashboard — the time is spent on the wire or inside inference before the dashboard's TTFT timer starts: uploading a multi-MB request body on a slow uplink, provider queueing, or prefilling an uncached prompt. `requestBytes` shows how much had to be uploaded.
- Prompt-cache miss check — the summary's `usage.cacheRead` near 0 with `cacheWrite` close to the full prompt size means the provider re-prefilled the whole context instead of reading its prompt cache. `sessionId` is the cache key the client sends for OpenAI-family providers (session-affinity headers and `prompt_cache_key`); Anthropic instead caches the message prefix, so watch `cacheRead`/`cacheWrite` there.
- Every retry re-issues the turn and gets a fresh request sequence number (`requestSeq`), so a silent retry loop shows up as several request timelines plus the usual auto-retry status.

Useful service commands:

```bash
wasmedge-agent status
wasmedge-agent doctor
wasmedge-agent doctor --fix
wasmedge-agent shutdown
```

## Validation

```sh
cargo run --locked -p xtask -- check
cargo test --release --locked --workspace --lib
cargo test --release --locked -p wasmedge-agent-sdk --doc
cargo test --release --locked -p pa-cli --test native_cells -- --ignored
```

The repository check validates branding, report links, formatting and all Cargo targets. The native integration test uses a scripted model with the public executable and real WasmEdge cells.
