# Development

See the repository [AGENTS.md](../../../AGENTS.md) for the current contribution rules and required validation.

## Setup

WasmEdge Agent requires Node.js 22.8.0 or newer.

```bash
git clone https://github.com/hydai/wasmedge-agent
cd wasmedge-agent
npm ci
```

Run from source:

```bash
/path/to/wasmedge-agent/wasmedge-agent.sh
```

The script can be called from any directory and preserves the caller's working directory. Use that behavior to run a source checkout against a separate test project.

## Product and Source Names

WasmEdge Agent is the product, public CLI, release artifact, and repository name. The monorepo still retains inherited `@earendil-works/pi-*` npm workspace names, a source-package `pi` bin entry, the `pi` package manifest key, and some `PI_*` compatibility environment variables. These names are source and compatibility details, not a signal that contributors should install or develop against pi-mono.

Public releases are currently versioned tarball artifacts installed by the stable and beta installer scripts. `scripts/pack-wasmedge-agent-release.mjs` rewrites the coding-agent package name, executable, config metadata, and internal dependency URLs for that distribution. Do not document the inherited npm workspace package as the public WasmEdge Agent install path.

## Local Configuration

User configuration lives under `~/.wasmedge-agent/`. Project-local settings, prompts, themes, extensions, skills, and system-prompt files live under `.wasmedge-agent/` in the project root. Override the user config directory with `WASMEDGE_AGENT_CODING_AGENT_DIR` and the session directory with `WASMEDGE_AGENT_SESSION_DIR`.

Use an isolated config directory when manually exercising daemon behavior so development sessions do not collide with normal sessions:

```bash
WASMEDGE_AGENT_CODING_AGENT_DIR=/tmp/wasmedge-agent-dev /path/to/wasmedge-agent/wasmedge-agent.sh
```

## Daemon Protocol Changes

Classify every daemon command, event, or response-shape change as backward-compatible, capability-gated, or incompatible. Optional behavior must be negotiated and degrade locally. Follow the protocol-version, schema-revision, compatibility-map, and cross-version test requirements in the root `AGENTS.md` before changing the wire contract.

## Package Asset Resolution

WasmEdge Agent runs from source, Node.js package output, and standalone release artifacts. Always use `src/config.ts` helpers for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Do not resolve packaged assets directly from `__dirname`.

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

After code changes, run the repository check from the root:

```bash
npm run check
```

This performs formatting, linting, type checking, installer rendering checks, and the browser smoke check. It does not run the test suite.

Run focused tests from the package root. For example:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

If you create or modify a test file, run that file and iterate until it passes. Coding-agent suite regressions belong under `test/suite/regressions/` and use the suite harness and faux provider rather than live provider credentials.

## Capability Evals

End-to-end capability evals live under `scripts/evals/` and are not part of CI: a real-model run is a manual step with credentials in the environment. Each harness ships model-free self-tests that validate its fixtures and rubric without any model call - run them from the eval directory:

```bash
cd scripts/evals/swarm_fanout
uv run --locked ruff check .
uv run --locked python -m unittest discover -s tests -v
```

See `scripts/evals/README.md` for the rubric and the real-model run instructions.
