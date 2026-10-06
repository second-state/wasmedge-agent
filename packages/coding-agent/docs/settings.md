# Settings

WasmEdge Agent uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.wasmedge-agent/settings.json` | Global (all projects) |
| `.wasmedge-agent/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `subagentDefaultModel` | string | - | Model selector (`"provider/id"`) used when `rlm.spawn` does not pin a model; unset inherits the parent model |
| `imageModel` | string | none | Model (`"provider/model-id"` or a bare id) that serves turns attaching images when the session model does not accept image input |
| `defaultThinkingLevel` | string | `"medium"` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

`subagentDefaultModel` applies only to spawned subagents whose `rlm.spawn` call omits `model=`. An explicit `model=` per spawn always wins, and an unset setting keeps the inherit-parent behavior. If the configured default is unavailable, unauthenticated, or expired, the spawn fails with that error instead of silently falling back.

When `defaultThinkingLevel` is unset, new sessions start at `"medium"` reasoning, clamped to the levels each model supports.

`imageModel` routes image turns on text-only session or subagent models. When a
turn attaches images and the selected model has no image input, that turn (and
its retries and post-compaction continuations) is served by the configured
image-capable model instead; the session model selection stays unchanged, and
the routed assistant messages record the model that served them. Later
image-free turns return to the session model, where images already in the
transcript appear as "(image omitted: model does not support images)"
placeholders. With no `imageModel` set (default), image turns on a text-only
model fail with an actionable error instead of silently dropping the images:
switch the session model with `/model` or configure `imageModel`. Set
`images.blockImages: true` to drop images everywhere instead of routing or
refusing.

### Autonomous Runs

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `autonomous.maxContinuations` | number or `"unlimited"` | `3` | Continuation budget for autonomous runs |
| `autonomous.maxTurns` | number or `"unlimited"` | `12` | Turn budget for autonomous runs |
| `autonomous.maxTokens` | number or `"unlimited"` | `80000` | Token budget for autonomous runs |
| `autonomous.timeoutMs` | number or `"unlimited"` | `1800000` | Wall-clock budget in milliseconds |

```json
{
  "autonomous": {
    "maxContinuations": "unlimited",
    "maxTokens": 1000000
  }
}
```

These are the persisted defaults for the same limits as the `--autonomous-*` CLI flags and `/autonomous on` budget flags. Set them once so every autonomous run starts with your budget instead of the built-in defaults; explicit flags on a given run still win. Invalid values are ignored per-field, falling back to the built-in defaults.

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

Conversation output starts at the `chatDetail` level (default `details`). Ctrl+O cycles overview -> details -> all output and saves the choice, so new, resumed, and attached chats open at the level you last picked. The old `hideThinkingBlock` setting no longer controls visibility.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | detected | Theme name (built-ins: `"prime"`, `"dark"`, `"light"`; or custom). Unset uses `"prime"` on dark terminals and `"light"` on light terminals |
| `quietStartup` | boolean | `false` | Hide startup header |
| `treeFilterMode` | string | `"user-only"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `chatDetail` | string | `"details"` | Conversation detail level: `"overview"`, `"details"`, or `"all"`. Ctrl+O updates it |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |

### Update Checks

An official release records the host it was published to (`<base>`), and the manifest is fetched from there: stable builds fetch `latest.json` at `<base>/latest/download/latest.json`, and beta builds fetch `beta.json` at `<base>/download/beta/beta.json` and continue following beta updates. `WASMEDGE_AGENT_DOWNLOAD_BASE_URL` overrides `<base>`. A build that was not packed for release records none, and runs no update check.

Set `PI_SKIP_VERSION_CHECK=1` to disable the WasmEdge Agent version update check. Use `--offline` or `PI_OFFLINE=1` to disable startup network operations, including update checks and package update checks.

The stable `latest.json` and beta `beta.json` manifests use the same JSON shape:

```json
{
  "version": "0.73.1",
  "package": "wasmedge-agent",
  "tarball": "download/v0.73.1/wasmedge-agent-0.73.1.tgz"
}
```

`version` is required. `package` is optional and may also be named `packageName`; it defaults to the current package name. `tarball` is optional; when present, WasmEdge Agent installs that tarball instead of the package name. Relative tarball paths resolve against `<base>`: the host an official release records, or `WASMEDGE_AGENT_DOWNLOAD_BASE_URL` where it is set, under `<base>/download/v<version>/<file>`.

A custom host set through `WASMEDGE_AGENT_DOWNLOAD_BASE_URL` must serve all three shapes: `<base>/latest/download/latest.json`, `<base>/download/beta/beta.json`, and `<base>/download/v<version>/<file>` for every file a manifest names.

### Pseudonymous usage analytics

WasmEdge Agent ships no telemetry collector. Pseudonymous, aggregate usage and performance events are sent only when `WASMEDGE_AGENT_TELEMETRY_ENDPOINT` names an ingestion endpoint; without it, telemetry is off regardless of the settings below. When an endpoint is configured, these events include version and operating-system category, onboarding outcome and duration, execution mode (`interactive`, `print`, `json`, `rpc`, or `acp`), run outcomes, TTFT and latency, prompt and turn counts, token usage, tool success counts, retries, and compactions.

Every event also carries a small platform descriptor, used to decide which prebuilt binaries WasmEdge Agent has to ship:

| Property | Values |
|----------|--------|
| `os_family` | `linux`, `darwin`, `win32`, ... |
| `architecture` | `arm64`, `x64`, ... |
| `install_method` | `bun-binary`, `homebrew`, `npm`, `pnpm`, `yarn`, `bun`, `unknown` |
| `libc` | `glibc`, `musl`, `none` (not Linux), `unknown` |
| `libc_version` | glibc runtime version such as `2.39`, else `unknown` |
| `cpu_baseline` | `avx2`, `no_avx2` (both measured on x86_64), `avx2_assumed` (Intel Macs, inferred), `not_applicable` (not x86_64), `unknown` |
| `os_release` | kernel version such as `6.8.0-45-generic` or `24.6.0` |
| `os_product_version` | macOS product version such as `15.6`; `unknown` elsewhere |

Most of these are coarse platform categories shared by millions of machines. `os_release` is the one exception: it is the raw kernel release string, capped at 64 characters. Stock kernel names such as `6.8.0-45-generic` are shared widely, but custom or self-built kernels can embed organization-, user-, or machine-specific labels in that string, so `os_release` is not guaranteed to be non-identifying. The remaining fields contain no hostname, username, path, serial number, or other hardware identifier.

WasmEdge Agent does not send prompts, responses, thinking, tool arguments or results, command text, filenames, paths, repository information, environment variables, credentials, raw error messages, hostnames, usernames, emails, or hardware identifiers. A random installation ID is stored as `telemetry.json` in the configured agent directory (normally `~/.wasmedge-agent/`).

Telemetry can be disabled globally or for an individual project. Project settings can only further restrict telemetry: they cannot re-enable a global opt-out or suppress the global one-time disclosure.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `telemetry.enabled` | boolean | `true` | Send pseudonymous aggregate usage and performance events |

Disable analytics with any of:

```json
{
  "telemetry": {
    "enabled": false
  }
}
```

```bash
WASMEDGE_AGENT_TELEMETRY=0 wasmedge-agent
DO_NOT_TRACK=1 wasmedge-agent
wasmedge-agent --offline
```

`WASMEDGE_AGENT_TELEMETRY_ENDPOINT` sets the ingestion endpoint for development and self-hosted deployments; telemetry stays off while it is unset.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested retry delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g. a usage-limit reset hours away), auto-retry stops immediately with an informative error instead of waiting. Set to `0` to disable the cap.

### Wait-for-usage and provider recovery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.provider.waitForUsage.enabled` | boolean | `true` | Bounded wait-for-recovery loop for quota exhaustion and provider unavailability |
| `retry.provider.waitForUsage.baseDelayMs` | number | `1000` | First ping delay (doubles per ping) |
| `retry.provider.waitForUsage.maxDelayMs` | number | `300000` | Per-ping ceiling (5m) |
| `retry.provider.waitForUsage.maxAttempts` | number | `30` | Abort bound: maximum recovery pings |
| `retry.provider.waitForUsage.maxWaitMs` | number | `900000` | Abort bound: maximum total wait (15m) |
| `retry.provider.waitForUsage.pauseUntilReset` | boolean | `true` | Park quota-blocked sessions until the provider-reported reset instead of dying mid-task |
| `retry.provider.waitForUsage.maxPauseMs` | number | `86400000` | Abort bound: maximum single park (24h; clamped to 7d) |
| `retry.provider.waitForUsage.maxParks` | number | `8` | Abort bound: maximum parks per quota episode |
| `providerBackupModel` | string | none | Backup model ("provider/model-id" or bare id) used while the primary is quota-blocked or unavailable |

The wait loop runs under the `retry.enabled` master switch: with retries
disabled, no waits run either.

When a request fails with quota/subscription exhaustion (429s, usage limits), the
session waits for usage to come back: it pings the provider with exponential
backoff and jitter (1s doubling to a 5m ceiling) and resumes automatically when
the provider recovers. If the provider reports a reset time (Retry-After header
or "Try again in ~90 min" style text), the resume is scheduled exactly then
instead of pinging. Quick retries still run first for transient errors (5xx,
overload, network, and 404 routing blips); the wait loop takes over when they
are exhausted. Every wait shows attempts and the next check countdown in the
status line, and both abort bounds (`maxAttempts`, `maxWaitMs`) are hard stops:
waits never hang. When a reported reset time exceeds `maxWaitMs`, the wait gives
up immediately with an informative error instead of pinging pointlessly — raise
`maxWaitMs` to wait out long subscription windows.

When `pauseUntilReset` is on (the default) and such a reset is reported — e.g.
the ChatGPT-plan "Try again in ~7272 min" 429 — the session does not die
mid-task: it parks. The turn ends cleanly with a "parked until ..." status, the
park/resume transitions are recorded in the session log, and one durable
one-shot scheduled job (visible via `/cron`) wakes the session at the reset
time — or sooner when `maxPauseMs` caps the park. While parked the session
itself makes no model calls. The wake delivers an
in-context marker telling the model the pause happened and to continue the
interrupted task; that turn's single model call probes the quota. If the quota
is back, the task resumes with its context. If not, the session re-parks with
the newly reported reset, bounded by `maxPauseMs` per park and `maxParks` per
quota episode; when the budget is spent, it aborts exactly like the bounded
wait it replaced. Parks apply at the session level (subagents included), only
for quota failures with a provider-reported reset, and only when no backup
model took over; a `maxPauseMs` above 7 days is clamped. Set
`pauseUntilReset: false` to keep the pre-park behavior of failing immediately.

`providerBackupModel` routes failed turns to a user-defined backup model
instead of waiting while the primary is quota-blocked or unavailable. It is
disabled by default: with no setting, behavior is unchanged and requests never
silently switch models. When set, the retry status line shows an explicit
"retrying on backup model X" indicator, the switch is recorded in the session
log, and the session returns to the primary model automatically (the next turn
probes the primary again). If the backup reference cannot be resolved to an
available, authenticated model, the bounded wait runs instead.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetryDelayMs": 60000,
      "waitForUsage": {
        "enabled": true,
        "baseDelayMs": 1000,
        "maxDelayMs": 300000,
        "maxAttempts": 30,
        "maxWaitMs": 900000,
        "pauseUntilReset": true,
        "maxPauseMs": 86400000,
        "maxParks": 8
      }
    }
  },
  "providerBackupModel": "anthropic/claude-opus-4-7"
}
```

### Diagnostics

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `requestTiming` | boolean | `false` | Log per-request provider timing phases to the diagnostic log (see [Development: Request timing](development.md#request-timing)); `PI_REQUEST_TIMING=1` also enables it |

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show image type and dimensions in terminal |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Rust Cells

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `rustCell.cellTimeoutMs` | number | `120000` | Per-cell budget in ms (compile + run share it) |
| `rustCell.workspaceWritePolicy` | `"rw"` or `"ro"` | `"rw"` | Guest access to the project at `/workspace` |
| `rustCell.libraryTestGate` | boolean | `false` | Require sandboxed `agent_lib` tests before applying a cell's `lib` edits |
| `rustCell.rustdocToolchain` | string or null | `null` | Installed rustup toolchain for on-demand rustdoc JSON API queries |
| `rustCell.cellGasLimit` | number or null | `null` | Optional WasmEdge gas budget per execution; integer from 1 to 4294967295 |
| `rustCell.cellMemoryPageLimit` | number or null | `null` | Optional maximum 64 KiB pages per Wasm linear memory; integer from 1 to 65536 |
| `rustCell.preludeExtra` | array | `[]` | User-selected crates.io dependencies available under `agent_lib::prelude::extra` |

Set `"rustCell": { "libraryTestGate": true }` to validate nonempty `lib` edits
in a disposable workspace before applying them. The gate builds `agent_lib` unit
and integration tests with release/offline Cargo, then runs every test module in
WasmEdge. It requires the standard Rust test harness and at least one passing,
non-ignored test; a library with no tests is rejected. Put unit tests alongside
helpers in `src/`, or maintain integration tests under `agent_lib/tests/` through
host tools. Tests have only disposable `/scratch` access, without project,
state, harness, or bridge access, and share the cell deadline and resource limits.
Failure or cancellation leaves the submitted cell and library edits unapplied.
Calls without `lib` edits keep their existing behavior. Restart or `/reload`
after changing the setting; child sessions inherit it, and SDK Rust tools accept
the same option. This does not generate tests, run doctests, rerun every skill's
tests against the proposed edits, or isolate Cargo build scripts from the host.

Set `"rustCell": { "rustdocToolchain": "nightly-2026-09-25" }` to enable
`rlm::api::list(path)`, `list_page(path, offset)`, and `describe(path)` for
`agent_lib`, its mounted skills, and `rlm`. Install the toolchain explicitly:

```sh
rustup toolchain install nightly-2026-09-25 --profile minimal --target wasm32-wasip1
```

Restart or `/reload` after changing the setting. Child sessions inherit it;
SDK Rust tools accept the same option. Queries never install a toolchain or
download dependencies. The pinned nightly produces supported rustdoc JSON
format 61; other formats are rejected. Normal cell compilation keeps its usual
toolchain. See [API introspection](rlm-runtime.md#api-introspection) for the query
format, cache behavior, and compilation boundary.

Set `"rustCell": { "workspaceWritePolicy": "ro" }` to mount `/workspace` read-only
for Rust guest execution. The prompt directs cells to produce patches and use the
existing host `bash` tool to apply them, or return them to the caller when bash is
unavailable. `/agent/state`, `/scratch`, and declared library edits remain writable.
The default `"rw"` keeps direct guest edits. Invalid values (including `null`)
reject runtime setup. Restart or `/reload` after changing the policy; children
inherit the session settings. The SDK `createRustTool` option has the same name.

Readonly mode requires the project and writable session mounts to be separate,
including resolved symlink roots. Host mount paths containing `:` are rejected
because WasmEdge uses colons as mount delimiters. There is no writable fallback.
This is a guest capability restriction: Cargo/build scripts, host bash, and host
handlers retain host permissions. It is not a read-only agent pipeline or a
patch approval/replay system.

Gas and memory limits apply to cells and each sandboxed skill test module. For example,
`"rustCell": { "cellGasLimit": 100000000, "cellMemoryPageLimit": 4096 }`
sets a gas budget and a 256 MiB linear-memory ceiling. Omit a limit or set it to
`null` to retain WasmEdge's default; invalid values reject runtime setup instead
of silently disabling the limit. Restart the session or use `/reload` after edits.

These are per-execution limits, not a shared budget across cells, test modules,
or subagents. Memory pages do not bound total process RSS, compiler memory, or
host handlers; the host `bash` tool is outside both limits. Gas exhaustion returns a runtime error; a denied `memory.grow`
can be handled by the guest, while a small cap can cause initialization or
allocation failure. The wall-time budget remains active, including time
spent waiting for host calls. The gas range also avoids truncation in WasmEdge 0.14.1.

Toolchain locations are environment variables, not settings: `WASMEDGE_AGENT_CARGO`, `WASMEDGE_AGENT_WASMEDGE`, `WASMEDGE_AGENT_TEMPLATE_DIR`, `WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS`.

To add a crate, configure an exact release version and reload:

```json
{
  "rustCell": {
    "preludeExtra": [{ "name": "itoa", "version": "1.0.18" }]
  }
}
```

Cells can then use `extra::itoa::Buffer::new()` after `use agent_lib::prelude::*;`.
Crate names use lowercase ASCII letters, digits, hyphens or underscores; hyphens
become underscores in Rust paths. Each entry accepts `name`, an exact `x.y.z`
`version`, optional `features` (crate-local feature names), and `defaultFeatures`
(default `true`). Version ranges, prereleases, Git/path sources, duplicate Rust
names, built-in dependencies and mounted skill name collisions are rejected.
The project list replaces the global list; set `[]` to remove configured crates.

The host vendors dependencies and release-builds the retained cell for
`wasm32-wasip1` in a staged workspace before publishing changes. This preparation
may access crates.io and takes place outside the per-cell execution budget.
Failure preserves the previous workspace. Removing a crate still used by the
retained cell, library or skills therefore fails; remove those references first.
Matching workspaces and child snapshots reuse their lockfile and vendor directory,
so subsequent cells compile offline. The shared template is unchanged.
Configured dependencies are trusted host build inputs: build scripts and proc
macros run on the host during compilation. Guest execution still uses the existing
import restrictions. For the curated catalog, cells can instead use
[`rlm::deps::add`](rlm-runtime.md#workspace-lifecycle) without changing settings.
Those additions persist separately; `preludeExtra: []` only removes user-configured
entries. Explicit settings take precedence for matching crate names.

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

Normally the package manager's global modules location is queried using `root -g`. As a special case, if the first element of `npmCommand` is `"bun"`, the modules location will instead be queried with `pm bin -g`.

### Daemon

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `idleEvictionMinutes` | number or `"off"` | `90` | Idle threshold in minutes for whole-tree worker eviction and individual idle-child passivation; `"off"` disables both. |

`idleEvictionMinutes` is a global daemon policy and is read only from `~/.wasmedge-agent/settings.json`. Set it to a positive number to configure the idle threshold.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".wasmedge-agent/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `WASMEDGE_AGENT_SESSION_DIR`, the legacy `WASMEDGE_AGENT_CODING_AGENT_SESSION_DIR`, then `sessionDir` in `settings.json`.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Alt+M cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.wasmedge-agent/settings.json` resolve relative to `~/.wasmedge-agent`. Paths in `.wasmedge-agent/settings.json` resolve relative to `.wasmedge-agent`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |
| `enableBuiltinSkills` | boolean | `true` | Load built-in skills shipped with wasmedge-agent |
| `bundledSkills.websearch` | boolean | `true` | Load the built-in `websearch` skill |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

Disable the built-in `websearch` skill while keeping normal skill discovery enabled:

```json
{
  "bundledSkills": {
    "websearch": false
  }
}
```

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "xhigh",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.wasmedge-agent/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.wasmedge-agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .wasmedge-agent/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
