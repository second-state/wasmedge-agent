# RLM Runtime Architecture

WasmEdge Agent gives each agent session a sandboxed Rust cell engine and a native recursive sub-agent interface. The guest `rlm` crate is a model-facing shim; the TypeScript host owns child execution, persistence, usage accounting, and lifecycle.

## Architecture

```mermaid
flowchart TD
    session["AgentSession · TypeScript<br/>rust tool + host request handlers"]
    provisioner["RustCellProvisioner · TypeScript<br/>toolchain checks · template clone · skill mounts"]
    runner["CellRunner · TypeScript<br/>cargo build → wasmedge run"]
    bridge["BridgeServer · TypeScript<br/>loopback TCP + bearer token"]
    cell["cell.wasm · WasmEdge<br/>agent_lib + rlm crates"]

    session -->|"owns"| provisioner --> runner
    session -->|"handlers"| bridge
    runner -->|"spawns per cell"| cell
    cell <-->|"typed requests (NDJSON)"| bridge
    bridge -->|"typed dispatch"| session
```

When the model delegates work:

```rust
let handle = rlm::spawn_named("inspect the API", "api-reviewer")?;
println!("{} {} {} {}", handle.rlm_child_id, handle.name, handle.session_dir, handle.model);
```

the call travels as a typed request over the cell's bridge connection. The host dispatches request type `rlm.run` to the parent `AgentSession`, which starts a child through the same TypeScript agent machinery as the parent. The call returns immediately after task admission with a child handle; it never waits for or returns the child's answer. Results arrive only through explicit agent-message replies or files.

The same bridge supports the other typed host requests: `rlm::goal`, `rlm::msg`, `rlm::compact`, `rlm::heartbeat`, `rlm::mcp`, `rlm::display`, and the generic `rlm::host_request(type, payload)` gate. State and policy remain in the TypeScript host.

## Cell Execution Pipeline

Each `rust` tool call runs one complete program:

1. Optional `lib` files are applied to `agent_lib/` (declarative extension, with backups).
2. The cell source is written to `cell/src/main.rs` and compiled with `cargo build --release --offline -p cell`. Compiles across sessions share a concurrency gate (`WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS`).
3. A failed or interrupted build restores the previous cell source and lib files, including the generated helper module index. Compile errors return the rendered rustc diagnostics. Successful builds retain their source changes even if the cell later panics or times out; runtime side effects are not rolled back.
4. On success the wasm binary runs under WasmEdge with explicit preopens: the project at `/workspace`, persistent state at `/agent/state`, the extension crate read-only at `/agent/lib`, and scratch at `/scratch`. The runner checks readonly preopen binding with a separate inert Wasm module before the first execution; it never uses the submitted cell as a probe. Guest paths are absolute — WASI has no working directory, so cells address the project as `/workspace/...`.
5. stdout/stderr, per-lib-file diffs, display attachments, and sent agent messages are composed into one structured result. Waiting for a build permit, compilation, the preopen probe, and execution share the per-cell time budget (`rustCell.cellTimeoutMs`, default 120s) and cancellation signal.

No process lives between cells. Continuity comes from the workspace: `rlm::state` key-value entries and blobs under `/agent/state`, and functions promoted into `agent_lib`, are available to every later cell.

Optional `rustCell.cellGasLimit` and `rustCell.cellMemoryPageLimit` settings are enforced by WasmEdge's `--gas-limit` and `--memory-page-limit` flags. The same settings apply independently to each sandboxed skill test module. They default to unset; invalid values are rejected before provisioning, and unsupported runtime flags fail execution without retrying uncapped. Gas exhaustion is a runtime error, while denied linear-memory growth returns the Wasm failure value (which guest code may handle); small memory caps can also fail initialization or allocation. Memory limits apply per linear-memory instance, not to total process RSS, Cargo, host handlers, or aggregate subagent usage. See [settings](settings.md#rust-cells) for ranges and an example. Network egress restrictions remain unenforced by the runtime.

## Workspace Lifecycle

The guest workspace is cloned per session from a prebuilt template (`wasmedge-agent-runtime/template`): a cargo workspace holding `agent_lib` (the model-extendable prelude), `cell` (the compilation target), and `rlm` (the host-bridge shim). The template is vendored (`vendor/` + a committed crates-io redirect) and warm-built once — at install time or on first use — so clones build cells offline in seconds; on macOS the clone uses clonefile and carries the compiled `target/` for free.

Discovered Rust skills are mounted into the clone as `skills/<crate>` symlinks and re-exported through `agent_lib::skills`; a skill that fails its probe build is unmounted with a diagnostic instead of breaking cells. See [Skills](skills.md).

Persisted workspaces have their own local Git repository with an initial snapshot and a commit after each successful cell. Commits record the cell source, library and runtime sources, manifests, skill mounts, and `state/` (including blobs); messages contain a sequence number and tool-call ID. Build caches, vendored dependencies, and scratch files are excluded. External skill symlinks record the mount, not the external source contents. Project files and harness stores are outside this repository. Failed cells do not create commits, and snapshots do not roll back runtime side effects. A Git failure after successful execution is reported separately in the tool result without rerunning the cell. Non-persistent sessions do not initialize Git.

Toolchain resolution:

1. `WASMEDGE_AGENT_CARGO`, else `cargo` on PATH, else `~/.cargo/bin/cargo`;
2. `WASMEDGE_AGENT_WASMEDGE`, else `wasmedge` on PATH, else `~/.wasmedge/bin/wasmedge`;
3. the `wasm32-wasip1` target (prechecked via rustup when present);
4. `WASMEDGE_AGENT_TEMPLATE_DIR` overrides the template location.

`doctor` reports these checks plus template vendor/build state, and `doctor --fix` repairs what does not require installing software.

On provisioning, `.workspace-version` records the installed template's content and dependency hashes, Rust compiler identity, WasmEdge version, and the template defaults for `agent_lib/src`. A version mismatch stages a scaffold upgrade beside the workspace: host manifests/configuration, `rlm`, vendored dependencies, and the template build cache are refreshed; skill mounts are regenerated; then the retained cell and library are built with `cargo build --release --offline -p cell`. The template sets Cargo's intermediate build directory to its own `target` so a global Cargo configuration cannot mix staged and other workspace artifacts. The retained cell is never executed during migration. The host publishes the staged workspace only after the build passes.

Upgrades retain helpers, skill sources, state/blobs, the last cell source, unrelated files, and Git history. Unmodified library defaults follow the template; locally changed or deleted library files remain local overrides. Workspaces predating the marker retain their existing library sources conservatively because their original defaults are unknown. An incompatible library or retained cell blocks the upgrade with compiler diagnostics and leaves the original workspace intact. The next provisioning attempt can retry; an abandoned upgrade journal recovers an interrupted directory switch. Provisioning rejects a live upgrade owner and malformed version metadata. This assumes one active runtime owns a session workspace.

The marker travels with a child's spawn-time seed and is included in subsequent Git snapshots. A seed from an older installation goes through the same migration before its first cell. Skill manifest changes still use the separate `.skills-hash` synchronization mechanism. This is a scaffold compatibility check, not a mandatory `cargo test` gate for cells.

## Delegation Flow

```mermaid
sequenceDiagram
    participant M as Parent model
    participant H as Parent AgentSession
    participant W as WasmEdge cell
    participant C as Child AgentSession
    participant P as Model provider

    M->>H: rust tool call
    H->>W: compile + run cell
    W->>H: bridge request · rlm.run
    H->>H: check depth and resolve model
    H->>H: admit child task and update registry
    H-->>W: SpawnHandle
    W-->>H: cell exit + structured result
    H-->>M: rust tool result
    H->>C: create child runtime and prompt
    loop Child agent loop
        C->>P: stream model request
        P-->>C: response or tool call
    end
    C-->>H: explicit agent-message reply
    H-->>M: ordinary agent message
    H->>H: update registry and attribute usage
```

## Component Ownership

| Component | Responsibility |
|---|---|
| `src/core/rust-cell/cell-runner.ts` | Compile pipeline, WasmEdge invocation, preopens, result composition, timeouts. |
| `src/core/rust-cell/index.ts` | Lazy provisioning: toolchain checks, template readiness, workspace clone, skill sync. |
| `src/core/rust-cell/workspace-history.ts` | Local Git snapshots after successful persisted cells. |
| `src/core/rust-cell/workspace-snapshot.ts` | Spawn-time library and cache copies with independent skill sources. |
| `src/core/rust-cell/bridge-server.ts` | Loopback bridge, bearer-token auth, framing, attachment thumbnailing, request dispatch. |
| `src/core/refinement/harness-api.ts` | Host-owned harness CRUD, skill validation/test gate, and persistence. |
| `src/core/tools/rust.ts` | Agent tool wrapper and output shaping. |
| `src/core/agent-session.ts` | RLM policy, child creation, registry, usage attribution, cancellation, and goal handlers. |
| `wasmedge-agent-runtime/template/rlm/` | Guest shim: typed bridge clients, state, harness, spawn handles. |
| `wasmedge-agent-runtime/template/agent_lib/` | Model-extendable prelude (file helpers, `skills` re-exports). |

The guest side does not call providers or implement an agent loop.

## Bridge Transport

The bridge is a loopback TCP listener created per session and connected per cell. `CellRunner` passes `RLM_BRIDGE_ADDR`, `RLM_BRIDGE_TOKEN`, and `RLM_CELL_ID` into the cell's WASI environment; the guest authenticates with the session-scoped bearer token (the threat model of Jupyter token auth), then exchanges newline-delimited JSON frames.

Guest calls are synchronous: `rlm::spawn` blocks the cell until the admission response arrives, which keeps the model-facing API free of async ceremony. Host handlers run concurrently on the host side; a cell that exits mid-request is disconnected and its side effects end with the cell. Display frames (`rlm::display::diff`, `attach_image`) are acknowledged per frame, and oversized or invalid attachments are reported back as frame errors without dropping the connection.

Cells with no bridge (standalone `wasmedge` runs) degrade: `rlm::bridge_available()` is false and bridge calls return a host-unavailable error.

## Guest API

The `rlm` crate exports, among others:

```text
rlm::spawn(prompt) / spawn_named(prompt, name) / spawn_with(prompt, opts)
rlm::find_models(query) · rlm::list_subagents() · rlm::delete_subagent(selector)
rlm::state::{set, get, keys, remove} · blob variants
rlm::msg::{send_to_parent, send_to_child, send_to_sibling, broadcast, list_agents}
rlm::goal::* · rlm::compact::* · rlm::heartbeat::* · rlm::refine::*
rlm::harness::{local, global}
rlm::display::{diff, attach_image}
rlm::host_request(request_type, payload)
```

`SpawnHandle` contains `rlm_child_id`, `name`, `session_dir`, and `model`. It confirms admission only and never contains the child's answer.

Supported spawn options are:

- `name`: a unique readable child session name; and
- `model`: an exact `provider/model` selector from `rlm::find_models()`.

Unknown options fail instead of being ignored. Model search is bounded to active, non-expired credentials. If an exact selection is unavailable or fails auth preflight, spawn fails instead of silently falling back to another model. A child otherwise inherits the parent model.

## Child Execution

`AgentSession.runRlmChild()` performs the following sequence:

1. Check `RLM_DEPTH < RLM_MAX_DEPTH`.
2. Resolve the requested model or inherit the parent model.
3. Create a `sub-xxxxxxxx` child directory under the parent artifact directory and snapshot the parent's provisioned library, skills, and build cache before admission.
4. Admit the task into the parent registry and return its `SpawnHandle`.
5. In detached work, create a child `SessionManager`, `Agent`, and `AgentSession`.
6. Reuse provider hooks, resource loader, model registry, tools, transport, retry settings, and thinking configuration.
7. Run the child prompt, retain its session, and update lifecycle state independently of the admission call.
8. Attribute child usage to the parent assistant turn and persist the attribution.

Children receive incremented `RLM_DEPTH`, the inherited maximum depth, and their own `RLM_SESSION_DIR`. A child starts with the parent's `agent_lib` as it was at spawn, including helpers and copies of mounted skill sources. The snapshot also carries scaffold dependencies and the build cache; cache reuse still depends on Cargo's freshness checks. The child has a fresh cell source, empty `rlm::state`, and independent Git history. Parent and child library edits are independent. An unprovisioned parent uses its own inherited seed, if present, or the shared template. The default maximum depth is 1, so root sessions may create children and those children may not create grandchildren unless the limit is configured higher.

The frozen seed is stored under the child session directory as `.rust-workspace-seed/`, so delayed startup and daemon restoration before the first cell use the same snapshot. Existing child workspaces survive reload without being overwritten. Root skill mounts remain editable symlinks; inherited child skills are local copies and stay local on reload.

## Independent Delegation

Each spawn call admits an independent child and returns its handle immediately:

```rust
let api = rlm::spawn_named("review the API", "api-reviewer")?;
let tests = rlm::spawn_named("review the tests", "test-reviewer")?;
let audit = rlm::spawn_named("slow independent audit", "audit-reviewer")?;
```

End the turn instead of waiting for completion. Children send requested answers with `rlm::msg::send_to_parent(...)`, and replies arrive as ordinary agent messages over later turns. A child may instead write results to files for the parent to read. The host runs each admitted child as an independent `AgentSession`; daemon-backed children can be retained as independently addressable session workers.

## Parent-Scoped Sub-Agent Registry

The TypeScript parent maintains the authoritative direct-child registry. `rlm::list_subagents()?` returns stable child IDs, active-session IDs when daemon-backed, session IDs, names, directories, and running/completed status.

This registry survives compaction and parent restore. Successfully completed daemon-backed children are rehydrated from the parent artifact registry. Inline children remain inspectable in the current process but have no active-session ID.

The parent can continue a retained daemon child with `rlm::msg::send_to_child(name, message)?`. `rlm::delete_subagent` accepts an exact child ID, active-session ID, session ID, or unique name. Deletion cancels or closes the runtime, writes a durable tombstone, and removes the child from messaging and observation. It does not erase the transcript or artifacts on disk.

Registry scope follows the parent transcript. An unrelated new parent session does not inherit children.

## Usage and Cost Attribution

The admission handle does not contain usage or completion data. WasmEdge Agent asynchronously folds the child's assistant usage and cost into the parent assistant turn that launched it.

The parent transcript persists a `child_usage_attributed` entry containing:

- the target parent assistant message ID;
- the child usage being attributed; and
- the resulting aggregate usage.

On reload, the aggregate is reapplied to the parent message. Context-tree reporting subtracts attributed child usage when showing each node's own usage, so tree-wide own usage and root aggregate totals remain reconcilable. Child work increases billable session totals but does not inflate the parent model's context-window measurement.

## Continual Harness State

`rlm::harness` is a persisted state ledger for prompt notes, memories, reusable skill references, sub-agent specifications, and refinement events. It is not a second execution engine.

Session-local state lives in the session artifact directory under `harness/harness_state.json`; explicitly global entries live under `~/.wasmedge-agent/harness/`. These stores are host-owned and are not preopened into cells. All `rlm::harness` calls, including reads and non-skill edits, require a live bridge and use `harness.request`. The host selects the store from the session and scope, reloads it for each request, and saves atomically (tmp + rename). Guest API signatures and the schema remain unchanged; standalone guests without a bridge can no longer use harness CRUD. There is no cross-process transaction lock.

`/refine` runs a dedicated review over the current trajectory and applies small create/update/delete edits. Rollback uses recorded before/after snapshots. The base system prompt remains immutable; refinements are supplemental state. Skill entries reference mounted crates (`{"type": "rust", "use": "agent_lib::skills::<crate>", ...}`); kernel-era `python` references remain readable but can no longer be created.

Skill `create_skill`, `update_skill`, and `update("skill", ...)` calls require a live bridge and passing sandboxed unit/integration tests before saving, using the same test runner as `/refine`. Tests receive only disposable scratch access. The host validates the reference, runs the tests, then reloads the store before saving and rejects an update if that entry changed in the meantime. Skill test requests use the cell budget instead of the ordinary 30-second bridge timeout; cancellation, cell end, or disconnection cancels their host work. The host ignores guest-supplied test results and entry version/source fields. Non-skill edits and deletion do not require tests.

Before compilation and again before execution, the runner rejects writable `/workspace`, `/agent/state`, or `/scratch` mounts that overlap either configured harness store, including symlinked mount roots, store parents, and existing state-file targets. Keep project directories separate from session/agent storage; using a home directory or a project containing its session storage as `/workspace` can now be rejected. This prevents direct guest file writes through the configured mounts. Host bash, build scripts/proc macros, host-created hard links, and concurrent host filesystem changes remain outside this boundary.

## Goal Requests

The `rlm::goal` module is a thin host-bridge client:

```rust
rlm::goal::get()?;
rlm::goal::create("ship the release", GoalOpts { token_budget: Some(200_000) })?;
rlm::goal::complete()?;
```

Goal state, persistence, token and wall-clock accounting, and continuation prompting live in `AgentSession`. When goals are disabled, the `goal.*` host handlers are not registered and the calls fail cleanly.

## Session Artifacts

For a persisted root session, the relevant layout is:

```text
~/.wasmedge-agent/
  sessions/
    <root-session-id>.jsonl
  session-artifacts/
    <root-session-id>/
      workspace/            # cloned cargo workspace: agent_lib, cell, state/, skills/
      scheduled-jobs.json
      harness/
        harness_state.json
      sub-xxxxxxxx/
        <child-session-id>.jsonl
        sub-yyyyyyyy/
```

Exact artifact files are created only when their features are used. Non-persistent sessions place RLM directories under the OS temporary directory and do not gain revivable session artifacts.

## Trust Boundary

Cells run as WebAssembly inside WasmEdge with only the preopened directories above: the agent's own computation is sandboxed by default, and provider credentials never enter the guest. Two honest limits: `/workspace` is writable in the default configuration, and the no-direct-network property currently rests on the crate surface rather than a runtime deny policy. The `bash` tool and the host toolchain (`cargo`, which can run build scripts) execute with the worker's OS permissions — their approval policy is the boundary for untrusted repositories. Installed skills and extensions are trusted code.

Provider credentials are resolved by the TypeScript host. The bounded model catalog crosses into the guest as metadata; the full auth store does not.

## Failure Modes

| Failure | Behavior |
|---|---|
| Toolchain missing | Provisioning fails with the doctor-style hint; `doctor --fix` repairs target/template issues. |
| Compile error | Lib changes revert; rendered rustc diagnostics return as the tool result. |
| Depth limit reached | The host rejects `rlm.run`; the guest surfaces the typed error. |
| Unsupported options | Host rejects the request. |
| Requested model unavailable | Spawn fails instead of substituting another model. |
| Cell timeout / abort | The process group is killed; queued builds abort as the same result shape. |
| Broken skill crate | Unmounted with a diagnostic; other skills and cells keep working. |
| Child cancellation | Host aborts the child and removes failed/cancelled registry entries. |
| Parent teardown | Active descendants are cancelled and their runtimes are closed. |

## Focused Validation

From `packages/coding-agent`, the implementation is covered by focused unit tests (`rust-cell-runtime`, `rust-cell-bridge-server`, `settings-manager`) and toolchain-gated integration tests (`rust-cell-bridge-integration`, `rust-cell-skills`, `rust-cell-harness`) that need `cargo`, the `wasm32-wasip1` target, and a `wasmedge` binary (`WASMEDGE_AGENT_WASMEDGE`). When changing child creation or accounting, include `agent-session-recursion.test.ts`; when changing the bridge, include the bridge server and native `rlm` tests (`cargo test --release --target <host>` in `wasmedge-agent-runtime/template/rlm`).
