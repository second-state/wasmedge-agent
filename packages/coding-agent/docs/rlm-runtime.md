# RLM Runtime Architecture

WasmEdge Agent gives each agent session a sandboxed Rust cell engine and a native recursive sub-agent interface. The guest `rlm` crate is a model-facing shim; the TypeScript host owns child execution, persistence, usage accounting, and lifecycle.

## Architecture

```mermaid
flowchart TD
    session["AgentSession · TypeScript<br/>rust tool + host request handlers"]
    provisioner["RustCellProvisioner · TypeScript<br/>toolchain checks · template clone · skill mounts"]
    runner["CellRunner · TypeScript<br/>cargo build → wasmedge run"]
    bridge["BridgeServer · TypeScript<br/>private stdio + bearer token"]
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

1. Before source edits, changed previously tested or harness-registered mounted skills must pass sandboxed tests again. Results are cached by source/dependency fingerprint within the runtime; reload/resume rechecks registered skills. Revalidation shares the cell deadline, and failure leaves the cell source and library untouched. See [Skills](skills.md#installed-skills-and-continual-harness-skills) for fingerprint scope and recovery. Optional `lib` files are then applied to `agent_lib/` (declarative extension, with backups).
2. The cell source is written to `cell/src/main.rs` and compiled with `cargo build --release --offline -p cell`. Compiles across sessions share a concurrency gate (`WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS`).
3. A failed or interrupted build restores the previous cell source and lib files, including the generated helper module index. Compile errors return the rendered rustc diagnostics. Successful builds retain their source changes even if the cell later panics or times out; runtime side effects are not rolled back.
4. The host validates the compiled module and rejects imports outside a fixed set of non-network WASI Preview 1 functions, before any cell code executes. Socket/DNS, plugin, unknown, and non-function imports are rejected even if unused. Validation uses the host JavaScript engine without instantiating the module; unsupported Wasm features fail closed. WasmEdge runs the accepted module with `--force-interpreter`, preventing embedded AOT native payloads from replacing the inspected code.
5. Execution has explicit preopens: the project at `/workspace` (writable by default, read-only with `rustCell.workspaceWritePolicy: "ro"`), persistent state at `/agent/state`, the extension crate read-only at `/agent/lib`, and scratch at `/scratch`. The runner checks library readonly preopen binding with a separate inert Wasm module before the first execution; it never uses the submitted cell as a probe. Guest paths are absolute — WASI has no working directory, so cells address the project as `/workspace/...`.
6. stdout/stderr, per-lib-file diffs, display attachments, and sent agent messages are composed into one structured result. Waiting for a build permit, compilation, import inspection, the preopen probe, execution, and the final Git snapshot share the per-cell time budget (`rustCell.cellTimeoutMs`, default 120s) and cancellation signal.

With `rustCell.libraryTestGate: true` (default: false), nonempty `lib` edits are
first applied to a disposable workspace snapshot. The host builds `agent_lib`
unit/integration tests with `cargo test --release --offline --target wasm32-wasip1
--no-run --lib --tests -p agent_lib`, validates all artifacts with the same import
allowlist, and runs them in WasmEdge with only `/scratch`. All modules must pass
and at least one non-ignored test must run. Validation shares the cell deadline,
cancellation, gas and memory limits. It checks source fingerprints before and
after testing, including the edited snapshot, and publishes no source edits on
failure. The normal cell build and its rollback behavior follow successful
validation. Library tests are not cached between edits; doctests and dependent
skill test suites are not included. Cargo retains host permissions unless `cargoSandbox` is enabled, and the
fingerprint has the same external-input limitations as skill validation.

Skill registration/revalidation, crate tests and rustdoc queries scan source
fingerprints asynchronously, streaming file contents and checking cancellation
between entries and chunks. Initial and final scans share the operation deadline;
cancellation waits for open files to close and does not cache a successful test.
Fingerprint identities and source-change checks remain compatible with existing
caches. Skill mount probes and state-restoration notices still scan synchronously.

No process lives between cells. Continuity comes from the workspace: `rlm::state` key-value entries and blobs under `/agent/state`, and code promoted into `agent_lib`, are available to every later cell.

Optional `rustCell.cellGasLimit` and `rustCell.cellMemoryPageLimit` settings are enforced by WasmEdge's `--gas-limit` and `--memory-page-limit` flags. The same settings apply independently to each sandboxed skill test module. They default to unset; invalid values are rejected before provisioning, and unsupported runtime flags fail execution without retrying uncapped. Gas exhaustion is a runtime error, while denied linear-memory growth returns the Wasm failure value (which guest code may handle); small memory caps can also fail initialization or allocation. Memory limits apply per linear-memory instance, not to total process RSS, Cargo, host handlers, or aggregate subagent usage. See [settings](settings.md#rust-cells) for ranges and an example.

## Workspace Lifecycle

The guest workspace is cloned per session from a prebuilt template (`wasmedge-agent-runtime/template`): a cargo workspace holding `agent_lib` (the model-extendable prelude), `cell` (the compilation target), and `rlm` (the host-bridge shim). The template is vendored (`vendor/` + a committed crates-io redirect) and warm-built once — at install time or on first use — so clones reuse vendored sources and the compiled `target/` for offline builds. Copying requests best-effort filesystem reflinks; support and cache reuse determine the actual cost.

Users can extend this dependency set with [`rustCell.preludeExtra`](settings.md#rust-cells). The host adds exact-version crates.io dependencies to the session workspace and re-exports them as `agent_lib::prelude::extra::<crate>`. Preparation vendors and release-builds in the scaffold upgrade's staging tree; dependency or compilation errors retain the original workspace. Settings contribute to workspace identity, so unchanged sessions and child snapshots reuse their prepared dependencies without fetching. This does not change the shared template. The generated `agent_lib/src/prelude_extra.rs` module is host-managed and regenerated on scaffold upgrades.

Cells can also call `rlm::deps::add("itoa")?` to enable a curated dependency for **subsequent cells**, then use `extra::itoa::Buffer::new()` after importing the prelude. The [curated catalog](../src/core/rust-cell/dependency-catalog.ts) pins 30 crates with default features, including CSV parsing, encoding, Unicode text, collections, hashing and version matching. Each crate has a representative API tested with the WasmEdge runner. Rust paths replace hyphens with underscores. Additions accept no version, feature, Git, or path arguments. Other crates require user configuration. Explicit `preludeExtra` settings take precedence for matching names.

The host first resolves against the workspace's existing vendor directory offline. Missing sources trigger host-side `cargo vendor` from crates.io in the staging workspace, before mounting skills; sources needed only by skills are retained. The current cell, library and mounted skills then release-build offline without execution. Resolution, fetching and building share the requesting cell's timeout and cancellation. Only dependency manifests, the generated prelude exports, dependency metadata and vendor sources are published; state directories and open guest files stay in place. Failed or cancelled fetches and builds retain the previous dependencies. New crates require registry access or a populated Cargo cache; already-vendored additions and unchanged resume/child snapshots work with an empty Cargo cache offline. Publication has a recovery journal for interrupted updates. Successful additions persist in `.cell-dependencies.json`, survive resume and child snapshots, and create a `chore(deps)` Git snapshot in persistent workspaces. Repeated additions are no-ops. A Git failure is reported as an already-applied addition with a failed snapshot. Additions are not rolled back if the requesting cell later fails, and there is currently no guest removal API.

Discovered Rust skills are mounted into the clone as `skills/<crate>` symlinks and re-exported through `agent_lib::skills`; a skill that fails its probe build is unmounted with a diagnostic instead of breaking cells. See [Skills](skills.md).

Persisted workspaces have their own local Git repository with an initial snapshot and a commit after each successful cell. Commits record the cell source, library and runtime sources, manifests, skill mounts, and `state/` (including blobs); messages contain a sequence number and tool-call ID. Build caches, vendored dependencies, and scratch files are excluded. External skill symlinks record the mount, not the external source contents. Project files and harness stores are outside this repository. Failed cells do not create cell snapshots; an earlier successful dependency addition keeps its own snapshot. Snapshots do not roll back runtime side effects. A Git failure after successful execution is reported separately in the tool result without rerunning the cell. Non-persistent sessions do not initialize Git.

Git initialization, cell snapshots and dependency snapshots are asynchronous.
Each complete operation has a 30-second ceiling, further bounded by startup or
cell time remaining and cancellation. Operations on one history instance are
serialized; waiting consumes the budget. Cancellation sends SIGTERM to the Git
process group, allows up to one second for lock cleanup, then uses SIGKILL if
needed. The runtime waits for process/pipe closure before releasing the workspace.
Automatic maintenance stays in the foreground so it is included in that wait.

If execution already succeeded, snapshot cancellation or timeout preserves the
cell's `ok` status and reports `workspaceCommitError`; it never reruns the cell.
A dependency already published is likewise retained if its snapshot fails.
Cancellation can arrive after a commit was written, including during maintenance,
so a snapshot error does not prove that no commit exists. Inspect history before
retrying. Forced termination or a host crash may leave Git locks; the runtime
never deletes them automatically. Confirm no Git process still owns the workspace
before repairing a stale lock. This does not coordinate external Git operations
or make workspace side effects transactional.

State and blob writes stage data in an exclusively created sibling directory,
then rename the completed file into place. Existing `.tmp` files, directories,
and symlinks are not reused as staging space. Cleanup is attempted on success or
an I/O error; process termination can leave a directory that later writes skip
and inventories omit. This does not make multiple state updates
transactional or serialize concurrent read-modify-write operations.

Resume and compaction notices list public free functions and type names found
by scanning `agent_lib/src/lib.rs` and its public modules. Types include structs,
enums, unions, type aliases, and traits (including unsafe traits). Paths are
relative to `agent_lib`, including nested and inline modules. A workspace with
only public types still receives a restore notice. Listings reflect current
source files, including applied or reverted library edits.

Both notices include saved state keys and blob names, without their contents.
Compaction reads an existing workspace from disk even before the first Rust cell
after resume or runtime reload. This does not initialize the toolchain, upgrade
the workspace, or start WasmEdge. A workspace is recognized by its `Cargo.toml`;
a new session without one receives no compaction state notice.

State inventory is best-effort: missing stores are empty, while unreadable stores
or a `state.json` that is not a valid JSON object produce explicit warnings.
Resume and compaction still deliver the readable inventory, even when only
warnings remain. Restore warnings are also visible in the TUI without expanding
the notice. Blob listings match `rlm::state::list_blobs`: all regular files,
including valid names ending in `.tmp`. Symlinks and directories, including
interrupted-write staging directories, are omitted. Legacy `.tmp` files may be
leftover writes or saved blobs; both are listed because the name cannot tell
them apart. Listing does not repair, delete, or overwrite saved data.

Without a matching API cache, these notices are labeled **source scan**. They do
not compile the library or report fields, variants, signatures, associated items,
re-exports, or generated API. Items with `cfg`, `cfg_attr`, or custom `path`
attributes are omitted rather than evaluated. A source-matched rustdoc cache
supplies the names instead and is labeled **cached rustdoc JSON**, with its
toolchain and a query hint. Notices show at most 64 function and 64 type names
from that cache and report the number omitted. Unreadable, malformed, or stale
caches fall back to source scanning; restore and compaction never invoke Cargo.

### API introspection

With `rustCell.rustdocToolchain` configured, cells can query documented public
APIs without guessing signatures or reading private implementation details:

```rust
use agent_lib::prelude::*;
fn main() -> Result<()> {
    println!("{}", rlm::api::list("agent_lib::helpers")?);
    println!("{}", rlm::api::describe("rlm::state::get")?);
    Ok(())
}
```

`list` returns public paths and item kinds below a module or type. Continue with
`list_page(path, nextOffset)` when `nextOffset` is non-null. `describe` returns
one exact path's documentation and **structured rustdoc declarations** (separate
type/value namespaces can share a path), including
function inputs/output, qualifiers, generics and bounds. Fields, variants,
inherent methods, trait items and explicit trait implementations have queryable
child paths. `impl#...` paths identify documentation entries, not Rust call
syntax. Macro-generated items, local aliases/globs and mounted skill re-exports
are resolved from rustdoc output. Raw keyword names retain their `r#` prefix.
Third-party re-exports without local JSON are labeled `external_reexport`;
unresolved globs use `*#...` entries. Synthetic and blanket impl inventories are
omitted. This is not a complete index of every external dependency or std trait.

Each list page has at most 50 entries and 32,000 bytes of item data. Long docs
are capped at 8,000 characters with `docsTruncated: true`; declarations are never
silently truncated. Oversized declarations return an error with a hint to query
smaller child items. Each JSON input/cache is limited to 32 MiB, and the index to
20,000 entries. Rustdoc JSON is unstable; this implementation accepts format 61,
tested with `nightly-2026-09-25`. Missing toolchains or unsupported formats return
errors rather than switching compilers or presenting a source scan as rustdoc.

On a cache miss, the host snapshots the workspace, then runs release/offline/
locked `cargo doc --target wasm32-wasip1 --no-deps --lib` for `agent_lib`, `rlm`
and mounted skills using the selected toolchain. Build admission, generation and
cleanup share the active cell's cancellation and deadline. Documentation does
not execute functions or doctests, but Cargo build scripts and proc macros still
use the configured `cargoSandbox` policy (host permissions by default). Rustdoc enables `cfg(doc)` and does not fully check
function bodies; this is API documentation, not proof that a cell compiles or
that code is correct. Guest gas/memory limits do not bound rustdoc or Cargo.

The cache is stored under `target/.agent-api.json`, outside Git snapshots. Queries
reuse it only when source fingerprints, selected toolchain, compiler version
and Cargo sandbox mode match. Fingerprints include manifests, Cargo.lock, Cargo configuration, library,
runtime and mounted skill sources; generation rejects changes in either the
live workspace or its snapshot. Source rollback can make the prior cache valid
again. Vendor content, arbitrary external build inputs and host environment are
not fingerprinted; this does not provide cross-process file locking. Resume and
compaction only verify sources and report the toolchain that produced the cache.

Queries read rustdoc JSON asynchronously with cancellation and the existing
32 MiB per-file limit. A cancelled cache check fails the query instead of treating
it as a cache miss and starting Cargo. JSON parsing and API indexing still run
synchronously, so the deadline is not a hard real-time bound.

### Toolchain resolution

1. `WASMEDGE_AGENT_CARGO`, else `cargo` on PATH, else `~/.cargo/bin/cargo`;
2. `WASMEDGE_AGENT_WASMEDGE`, else `wasmedge` on PATH, else `~/.wasmedge/bin/wasmedge`;
3. the `wasm32-wasip1` target (prechecked via rustup when present);
4. `WASMEDGE_AGENT_TEMPLATE_DIR` overrides the template location.

`doctor` reports these checks plus template vendor/build state, and `doctor --fix` repairs what does not require installing software.

On provisioning, `.workspace-version` records the installed template's content and dependency hashes, Rust compiler identity, WasmEdge version, and the template defaults for `agent_lib/src`. A version mismatch stages a scaffold upgrade beside the workspace: host manifests/configuration, `rlm`, vendored dependencies, and the template build cache are refreshed; skill mounts are regenerated; then the retained cell and library are built with `cargo build --release --offline -p cell`. The template sets Cargo's intermediate build directory to its own `target` so a global Cargo configuration cannot mix staged and other workspace artifacts. The retained cell is never executed during migration. The host publishes the staged workspace only after the build passes.

Upgrades retain helpers, skill sources, state/blobs, the last cell source, unrelated files, and Git history. Unmodified library defaults follow the template; locally changed or deleted library files remain local overrides. Workspaces predating the marker retain their existing library sources conservatively because their original defaults are unknown. An incompatible library or retained cell blocks the upgrade with compiler diagnostics and leaves the original workspace intact. The next provisioning attempt can retry; an abandoned upgrade journal recovers an interrupted directory switch. Provisioning rejects a live upgrade owner and malformed version metadata. This assumes one active runtime owns a session workspace.

Upgrade staging uses the same skill compile probes as normal startup before
validating the retained cell. Unused skills rejected by the probes are unmounted
and diagnosed; if the retained cell or library still depends on one, validation
fails and the original workspace stays in place. Unmounting removes symlinks
and generated Cargo/re-export entries but preserves inherited skill source
directories, so they can be repaired and remounted on reload.

The marker travels with a child's spawn-time seed and is included in subsequent Git snapshots. A seed from an older installation goes through the same migration before its first cell. Skill manifest, source, test, and fixture changes use the separate `.skills-hash` synchronization mechanism to repeat mount probes on reload. This is a scaffold compatibility check, not a mandatory `cargo test` gate for cells.

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
| `src/core/rust-cell/bridge-server.ts` | Bearer-token auth, framing, attachment thumbnailing, request dispatch. |
| `src/core/rust-cell/stdio-bridge.ts` | Separate protocol frames from ordinary stdout and deliver private replies on stdin. |
| `src/core/rust-cell/wasm-imports.ts` | Validate and enforce non-network imports for cells and skill tests. |
| `src/core/refinement/harness-api.ts` | Host-owned harness CRUD, skill validation/test gate, and persistence. |
| `src/core/tools/rust.ts` | Agent tool wrapper and output shaping. |
| `src/core/agent-session.ts` | RLM policy, child creation, registry, usage attribution, cancellation, and goal handlers. |
| `src/core/rlm-runtime.ts` | Typed request/spawn-handle validation for `rlm.run`, model discovery, list, and delete. |
| `wasmedge-agent-runtime/template/rlm/` | Guest shim: typed bridge clients, state, harness, spawn handles. |
| `wasmedge-agent-runtime/template/agent_lib/` | Model-extendable prelude (file helpers, `skills` re-exports). |

The guest side does not call providers or implement an agent loop.

## Bridge Transport

The bridge uses private process pipes; ordinary cells open no TCP listener or socket. `CellRunner` passes `RLM_BRIDGE_STDIO=1`, `RLM_BRIDGE_TOKEN`, and `RLM_CELL_ID` into the cell's WASI environment. The guest authenticates with the session token and active cell ID, then exchanges protocol-v1 newline-delimited JSON frames. Guest frames on stdout carry the prefix `\x1eRLM:<token>:`; the host removes those frames from visible output and writes replies only to stdin. stdin is reserved for the bridge. Ordinary stdout/stderr remain streamed, including output without a trailing newline and UTF-8 split across chunks. Frames are capped at 32 MiB.

Guest calls are synchronous: `rlm::spawn` blocks the cell until the admission response arrives. Ordinary requests have a 30-second guest deadline; skill registration tests use the cell budget. WASI polling keeps an absent reply from blocking past the guest deadline. After a transport timeout, the next call renews the handshake: the host aborts prior cooperative work and suppresses its late replies. Requests are never replayed automatically. Cell exit or cancellation also aborts cooperative host work; completed side effects are not rolled back. Display frames (`rlm::display::diff`, `attach_image`) are acknowledged per frame, and invalid attachments return frame errors without dropping the connection.

This transport preserves the stock WasmEdge CLI and existing host handlers while closing the socket-import gap. The planned T2 native runner and host-function ABI remain separate work. The native Rust protocol tests retain a TCP backend with `RLM_BRIDGE_ADDR`; WASI cells do not use it. Persisted workspaces refresh their `rlm` scaffold through the normal upgrade path.

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
rlm::skills::package(name, description, instructions, source)
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

Children receive incremented `RLM_DEPTH`, the inherited maximum depth, and their own `RLM_SESSION_DIR`. A child starts with the parent's `agent_lib` as it was at spawn, including helpers and copies of mounted skill sources. The snapshot also carries scaffold dependencies and the build cache; cache reuse still depends on Cargo's freshness checks. The child has a fresh cell source, empty `rlm::state`, and independent Git history. Parent and child library edits are independent. An unprovisioned parent uses its own inherited seed, if present, or the shared template. The default maximum depth is 2, so root sessions may create children and grandchildren; grandchildren may not create another generation unless the limit is configured higher.

Child seeds, sandboxed crate tests, dependency updates and rustdoc use asynchronous
snapshots. Copying checks cancellation between entries and waits for in-flight
filesystem calls before cleaning up. Child workspace preparation observes the spawning
cell's signal, parent disposal and `cellTimeoutMs` (two minutes by default).
A cancelled or failed preparation removes its child directory and releases the
reserved name; it never admits a child. `disposeAsync()` waits for preparation
and cleanup. After admission, the child's existing independent lifecycle applies.
Tests, rustdoc and dependency snapshots count toward their operation budgets.

This is not an atomic snapshot against concurrent external edits. One copy
syscall cannot be interrupted; skill mount probes, state notices and dependency
recovery still include synchronous work. Temporary test/rustdoc trees and ordinary dependency
transaction cleanup are removed asynchronously without abandoning pending I/O.

The frozen seed is stored under the child session directory as `.rust-workspace-seed/`, so delayed startup and daemon restoration before the first cell use the same snapshot. Existing child workspaces survive reload without being overwritten. Root skill mounts remain editable symlinks; inherited child skills are local copies and stay local on reload.

An inherited skill directory is preserved even if its `Cargo.toml` is missing. Reload unmounts the invalid skill with a diagnostic and keeps its local files for repair. Restore the manifest and reload to remount it.

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

`rlm::skills::package` sends `skills.package` to the host to create a project-local Rust skill under the project's config directory (`.wasmedge-agent/skills/<name>/`, with the existing config-directory fallback). The host generates `SKILL.md`, `Cargo.toml` with fixed workspace dependencies, and `src/lib.rs` from the supplied source. Names must start with a lowercase letter, use lowercase letters/digits/single hyphens, and fit 64 characters; reserved crate names and collisions with loaded skills are rejected. Existing destinations and symlinked parent directories are never overwritten or followed. The response contains the guest `path`, `crate_name`, `rust_use`, and `requires_reload: true`.

Packaging only creates files; it does not compile, test, mount, or register a skill. Reload with `/reload` or start a new session for normal discovery and mounting, then register through the tested harness API below. Supply complete library source with deterministic unit tests and document public signatures in `instructions`. This API creates project-local skills only, cannot add dependencies or overwrite an existing skill, and does not change the trust boundary for host compilation. Concurrent host filesystem changes remain outside its path checks.

Session-local state lives in the session artifact directory under `harness/harness_state.json`; explicitly global entries live under `~/.wasmedge-agent/harness/`. These stores are host-owned and are not preopened into cells. All `rlm::harness` calls, including reads and non-skill edits, require a live bridge and use `harness.request`. The host selects the store from the session and scope, reloads it for each request, and saves atomically (tmp + rename). Guest API signatures and the schema remain unchanged; standalone guests without a bridge can no longer use harness CRUD. There is no cross-process transaction lock.

`/refine` runs a dedicated review over the current trajectory and applies small create/update/delete edits. Rollback uses recorded before/after snapshots. The base system prompt remains immutable; refinements are supplemental state. Skill entries reference mounted crates (`{"type": "rust", "use": "agent_lib::skills::<crate>", ...}`); kernel-era `python` references remain readable but can no longer be created.

Skill `create_skill`, `update_skill`, and `update("skill", ...)` calls require a live bridge and passing sandboxed unit/integration tests before saving, using the same test runner as `/refine`. Tests receive only disposable scratch access. The host validates the reference, runs the tests, then reloads the store before saving and rejects an update if that entry changed in the meantime. Skill test requests use the cell budget instead of the ordinary 30-second bridge timeout; cancellation, cell end, or disconnection cancels their host work. The host ignores guest-supplied test results and entry version/source fields. Non-skill edits and deletion do not require tests.

Sandboxed skill tests share the cell import allowlist and interpreter requirement above. Every test artifact is checked before any module executes. Unlike ordinary cells, tests have no bridge connection or credentials. Cargo build scripts/proc macros use `cargoSandbox` when enabled; they retain host permissions by default.

Before compilation and again before execution, the runner rejects writable `/workspace`, `/agent/state`, or `/scratch` mounts that overlap either configured harness store, including symlinked mount roots, store parents, and existing state-file targets. Keep project directories separate from session/agent storage; using a home directory or a project containing its session storage as `/workspace` can now be rejected. This prevents direct guest file writes through the configured mounts. Host bash, build scripts/proc macros, host-created hard links, and concurrent host filesystem changes remain outside this boundary.

With `rustCell.workspaceWritePolicy: "ro"`, `/workspace` uses WasmEdge's `:readonly`
preopen. The runner also rejects writable state/scratch mounts overlapping the
project in either direction, resolving symlink roots and existing ancestors.
Host mount paths containing colons are rejected to avoid ambiguous CLI parsing.
These checks run before source edits/build and again before execution; there is
no fallback to a writable project. Existing harness isolation checks still apply.
Cells can read/search the project, save state, write scratch files, and submit
library edits. For project edits the prompt requests a patch, which the existing
host bash tool can apply (for example, `git apply` in the host project directory).
Without bash, the prompt asks the model to return the patch to its caller.
This adds neither a patch approval gate nor trajectory replay; host permissions
and the filesystem limitations above still apply. See [settings](settings.md#rust-cells).

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

Cells run as WebAssembly inside WasmEdge with only the preopened directories above. The runner denies direct guest networking through import validation and forced interpreter execution, including for cells with a bridge; network capabilities are available only through registered host handlers. This is a policy of the agent's runner, not a network restriction added to standalone WasmEdge. `/workspace` remains writable by default. The `bash` tool and host handlers execute with the worker's OS permissions. Cargo and its build scripts/proc macros do too by default; the optional Cargo sandbox below changes their process boundary. Installed skills and extensions are trusted code; the guest policy does not sandbox compilation or the whole agent.

Provider credentials are resolved by the TypeScript host. The bounded model catalog crosses into the guest as metadata; the full auth store does not.

Runtime-managed Cargo processes receive an environment allowlist, including template preparation, workspace upgrades, cell builds, skill probes/tests, and dependency resolution/vendoring. Rust compiler and rustup probes/repairs use the same policy. Inherited variables are limited to `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `WINDIR`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP`, `TMPDIR`, `SDKROOT`, `MACOSX_DEPLOYMENT_TARGET`, `CARGO_HOME`, `CARGO_NET_OFFLINE`, `RUSTUP_HOME`, `RUSTUP_TOOLCHAIN`, `RUSTUP_AUTO_INSTALL`, and `RUSTC` (case-insensitive on Windows). Skill test builds additionally receive host-selected target/build directories. Provider variables, registry tokens, proxy settings, compiler flags/wrappers, and other ambient variables are not inherited; setups that relied on those variables must account for this change. The host's own environment is unchanged.

This prevents unlisted parent environment values from reaching compilation through ordinary inheritance. Without `cargoSandbox`, it does not isolate compiler filesystem access: `include_str!`, build scripts, and proc macros still have host permissions, and Cargo configuration files can supply environment values or credentials. Existing artifacts are not scrubbed. Do not treat this policy as a guarantee that model-generated code cannot obtain provider credentials.

### Startup cancellation

Runtime toolchain probes, template vendoring/builds, configured dependency
vendoring, scaffold validation, skill compile probes and Git initialization run
asynchronously.
The `rust` tool forwards its abort signal during startup; runtime disposal also
cancels startup and waits for subprocess exit and staged-workspace cleanup.
Cancelled scaffold validation retains the original workspace. Cancelled skill
probes do not classify skills as broken or cache incomplete validation.

Each startup attempt has a five-minute budget, separate from `cellTimeoutMs`.
It includes the predecessor-runtime barrier, template queue, probes and Cargo
work. Startup builds share the ordinary cell-build concurrency limit; waiting
for a permit consumes the startup budget and can be cancelled. SDK callers can override it with `provisionTimeoutMs` on
`RustCellProvisioner` or `createRustTool`, and pass an `AbortSignal` as the second
argument to `ensure(onProgress, signal)`. Cancelling any caller waiting on the
same provisioner cancels the shared attempt, including prewarm; all callers
wait for cleanup before it can be retried. Cancelling a provisioner queued for
a different provisioner's template preparation does not cancel that owner.

Template preparation is serialized within one host process and rechecks caches
after acquiring ownership. Vendoring uses a unique temporary directory and
publishes only on success. Successful template work remains cached if a later
startup phase fails. There is no cross-process preparation lock; Cargo retains
its own build locking.

Initial workspace cloning and scaffold upgrades copy files asynchronously,
checking cancellation between entries, and stream source hashes with an abort
signal. Initial clones also stage beside the destination and publish only when
complete; cancelled copies do not leave a partially provisioned workspace.
Cancellation before publication retains the original workspace; cancellation
during cleanup keeps the completed, published tree. Copying preserves file
timestamps and literal symlinks and requests best-effort reflinks.

Staging cleanup is asynchronous. Cancellation waits for the current filesystem
call and open hash streams to finish before cleanup and retry; a single copy
syscall cannot be interrupted. Small metadata operations, systemd group setup,
skill mount fingerprints, state notices, and dependency crash recovery/rollback still
contain synchronous work.
Cleanup and these operations can extend elapsed time beyond the startup budget. Startup errors are reported by
the tool before a cell result exists. `doctor --fix` and installation keep their
synchronous maintenance APIs.

### Cargo sandbox

`rustCell.cargoSandbox: "bubblewrap"` is an opt-in Linux process sandbox, using
[Bubblewrap](https://github.com/containers/bubblewrap). It requires version 0.8+
at `/usr/bin/bwrap` and working unprivileged user namespaces. Other platforms,
missing binaries, unsupported flags and namespace failures fail closed. There
is no automatic installation or unsandboxed retry. The default `"off"` preserves
existing behavior. Reload after changes; sessions, children and standalone SDK
tools use the same setting.

On Ubuntu, an administrator may also need to load an AppArmor profile allowing
`userns` for `/usr/bin/bwrap`; see Ubuntu's [user namespace restrictions](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/#apparmor-unprivileged-user-namespace-restrictions).
Without it, Bubblewrap can fail during namespace setup with `RTM_NEWADDR:
Operation not permitted`. Runtime startup never changes system policy. CI grants
the exception only to `/usr/bin/bwrap` and leaves the global restriction enabled.

The policy covers template warmup, scaffold validation, skill probe builds,
ordinary cells, skill/library test compilation, dependency resolution/builds
and rustdoc generation. Compilation has a separate network namespace, PID/IPC/
UTS namespaces, no capabilities, disabled nested user namespaces and a new
session. Cancelling an asynchronous command kills its Bubblewrap supervisor;
the PID namespace also terminates detached build descendants. Runtime startup
Cargo commands participate in the same cancellation path.

The filesystem starts empty and exposes:

- Read-only `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, the loader cache and
  `/etc/alternatives`, plus selected Cargo/Rust tool directories and
  `RUSTUP_HOME`. These are trusted system/toolchain inputs; do not store secrets
  in them. Tool binaries, the kernel and Bubblewrap remain trusted.
- The read-only compilation workspace and linked skill source directories.
  Inputs can read one another. Unmounted project/home files are unavailable to
  `include_str!`, build scripts and proc macros. Git metadata, session state,
  scratch and the ordinary build cache are hidden. Other files deliberately
  placed in a build input directory remain readable.
- Writable `Cargo.lock` and `target/cargo-sandbox/`. The latter is the only
  persistent build output directory; enabling the policy does not reuse the
  ordinary unsandboxed target cache. Source/manifests cannot be rewritten by
  build scripts. Symlink cache roots and symlink/hard-linked lockfiles are
  rejected. Host consumers reject Wasm/rustdoc artifact links outside this cache.
  Existing sources and artifacts are not scrubbed of past data.
- Private `/tmp`, HOME and CARGO_HOME, minimal devices and a private `/proc`.
  The Cargo registry cache is read-only for compilation. User Cargo config,
  credentials files and unrelated parent-directory configs are absent;
  workspace Cargo config still applies within the restricted filesystem.

Host-managed `cargo vendor` uses the same filesystem policy but shares the host
network, exposes DNS/certificate configuration, and can write its selected
vendor directory and existing registry cache. Registry authentication through
user credentials/config is unsupported. Rustup auto-install is disabled; install
the required toolchains beforehand. Cargo/RUSTC binary overrides must be absolute
paths. Build scripts needing network access,
source-tree writes, external tools/assets or global Cargo config can fail under
this policy. It does not silently widen access to make them work.

This is a **compiler subprocess** boundary, not isolation of the entire agent.
Host provisioning/source copying, toolchain probes/repairs, `doctor --fix`,
installation, bash and host handlers retain host permissions. In particular,
source snapshots may already contain data copied by the host; this feature is
not a guarantee that model-generated code cannot obtain credentials through
other agent capabilities. Host filesystem races/hard links in inputs and kernel
exploits are outside this policy. Cargo sandboxing alone sets no process memory,
CPU or disk quota. Optional process limits below bound individual invocations;
Wasm gas/page limits still apply only to guest execution.

### Process resource limits

`rustCell.processLimits` optionally bounds runtime Cargo and WasmEdge invocations
with Linux cgroup v2. It requires `cargoSandbox: "bubblewrap"`, systemd 254+
at `/usr/bin/systemd-run` (plus `/usr/bin/systemctl` for tree budgets), a running user manager at `/run/user/<uid>/bus`, and
delegated `memory`, `cpu` and/or `pids` controllers for the requested fields.
An administrator may need to enable controller delegation on `user@<uid>.service`;
see systemd's [delegation documentation](https://systemd.io/CGROUP_DELEGATION/).
The runtime never installs tools, starts the manager or changes system policy.
Unsupported platforms, unavailable controllers and launch failures are errors;
execution never retries without limits. Omitted/null/empty settings keep the
existing execution path without any systemd requirement.

Every command gets a fresh systemd user scope. Before launching the compiler or
guest, the runner verifies the scope's actual kernel controls against the
requested values. The scope preserves working directory, literal arguments,
environment, output and private bridge pipes. Cargo remains inside Bubblewrap,
without access to the user bus or cgroup control files. Guest imports and mounts
retain their existing policy. These boundaries assume trusted system tools and
host code; host bash or handlers can still change user-owned policy.

- `memoryMaxMb` sets aggregate charged memory in MiB, including file cache,
  with no swap and group OOM killing. It is not a virtual-address-space or exact
  RSS ceiling. Exceeding it can kill Cargo, WasmEdge and their descendants.
- `cpuQuotaPercent` sets CPU bandwidth with a 100 ms period; 100 permits one
  core and 200 permits two. CPU-heavy work is throttled, not immediately killed.
  Existing wall-time deadlines still apply.
- `tasksMax` bounds processes plus threads across the invocation. At the limit,
  further process/thread creation fails, which the invoked program may handle.

`rustCell.treeProcessLimits` optionally adds a shared
[systemd slice](https://www.freedesktop.org/software/systemd/man/latest/systemd.slice.html)
above the invocation scopes. Parent and subagent runtimes use the same slice,
including Cargo invoked through a guest bridge request. The runner verifies both
the scope and its parent slice's kernel controls before executing. Separate root
sessions get independent slices. Per-invocation and tree limits are independent
settings; when both are enabled, both apply. Shared memory exhaustion kills a
selected invocation and its descendants, not necessarily all agents. Shared CPU
limits throttle total bandwidth; shared task limits can reject launches.

Coverage includes template warmup/vendoring, scaffold and skill probe builds,
cell compilation/execution, skill/library test builds and each Wasm test module,
dependency updates, rustdoc and the inert readonly-mount probe. The Node host, source copying, toolchain/version
probes, `doctor --fix`, installation and host bash/handlers remain outside these
limits. Disk quotas are not implemented.

The shared policy is immutable for the live root's lifetime. Runtime reload,
inline/hosted children, and daemon child rehydration retain the same group.
A new root session or process restart gets a fresh group; no resource accounting
is persisted across restarts. Disposal releases a session's reference after its
runtime stops. Only the last owner stops the slice and removes its runtime unit
properties, so closing one child does not stop siblings. An abrupt host crash
can leave the slice and its runtime properties until the user manager exits.
For an abandoned tree, an operator can stop and then revert its specific
`app-wasmedge_agent_<id>.slice` with `systemctl --user`; do not stop a live tree's
slice. Cleanup never selects units belonging to other trees.

SDK callers can create a `ProcessResourceGroup` and pass it as
`rustProcessGroup` to `createAgentSession`, or as `processGroup` to
`createRustTool`/`RustCellProvisioner`. Sessions retain their own references;
standalone tools/provisioners borrow the caller's reference. Keep the group alive
until borrowed runtimes finish and call `group.dispose()` when done. Custom
subagent runtime hosts must forward the parent's `rustProcessGroup` in child
creation options (including `null` for an uncapped tree); the built-in hosts do
this automatically.

Resource failures use existing compile/runtime error results; a killed process
may have no exit code or diagnostics. A kill alone is not proof of OOM. Build
failure still restores the submitted sources; runtime failure retains the
existing source/state semantics. See [settings](settings.md#rust-cells) for
ranges, examples and reload behavior.

## Failure Modes

| Failure | Behavior |
|---|---|
| Toolchain missing | Provisioning fails with the doctor-style hint; `doctor --fix` repairs target/template issues. |
| Compile error | Lib changes revert; rendered rustc diagnostics return as the tool result. |
| Invalid module / disallowed import | Cell does not execute; the tool reports the policy error. Successfully compiled source changes remain. |
| Depth limit reached | The host rejects `rlm.run`; the guest surfaces the typed error. |
| Unsupported options | Host rejects the request. |
| Requested model unavailable | Spawn fails instead of substituting another model. |
| Cell timeout / abort | The process group is killed; queued builds abort as the same result shape. |
| Broken skill crate | Unmounted with a diagnostic; other skills and cells keep working. |
| Child cancellation | Host aborts the child and removes failed/cancelled registry entries. |
| Parent teardown | Active descendants are cancelled and their runtimes are closed. |

## Focused Validation

From `packages/coding-agent`, the implementation is covered by focused unit tests (`rust-cell-runtime`, `rust-cell-bridge-server`, `settings-manager`) and toolchain-gated integration tests (`rust-cell-bridge-integration`, `rust-cell-skills`, `rust-cell-harness`) that need `cargo`, the `wasm32-wasip1` target, and a `wasmedge` binary (`WASMEDGE_AGENT_WASMEDGE`). When changing child creation or accounting, include `agent-session-recursion.test.ts`; when changing the bridge, include the bridge server and native `rlm` tests (`cargo test --release --target <host>` in `wasmedge-agent-runtime/template/rlm`).

### Cell timing

Rust tool results include versioned `details.timings` using a monotonic clock.
These milliseconds partition `durationMs`, from runner admission through final
cleanup/snapshot; `otherMs` accounts for uninstrumented work between phases.
Unreached phases are zero. Structured error, timeout and abort results retain
measurements; exceptions that prevent a structured result provide no timing.

| Field | Measured interval |
|---|---|
| `prepareMs` | Mount/state checks and source preparation |
| `skillValidationMs` | Registered-skill revalidation, including any nested build/test work |
| `libraryTestsMs` | Optional library-edit test gate, including snapshot/build/test/cleanup |
| `buildQueueMs` | Waiting for the main cell's in-process build permit |
| `cargoMs` | Main cell Cargo subprocess lifetime, including Cargo's own waits |
| `rollbackMs` | Restoring submitted sources after build failure |
| `importPolicyMs` | Reading and validating the produced Wasm imports |
| `probeMs` | First readonly-preopen probe and its cleanup; zero when already cached |
| `executionMs` | WasmEdge invocation, including argument/mount setup, process startup, guest execution and host-handler waits |
| `bridgeCleanupMs` | Cancelling/draining bridge handlers after WasmEdge exits |
| `snapshotMs` | Successful cell's Git snapshot attempt, including failed attempts |
| `otherMs` | Remaining admitted-runner elapsed time |

`timings.queueMs` measures submission-to-admission time on the same runner and
is **outside** `durationMs` and the cell deadline. `details.toolTiming.provisionMs`
measures `provisioner.ensure()` and startup callbacks; `totalMs` includes this,
the runner queue, execution and result assembly up to returning the tool result.
It excludes provider/model time and later transcript/UI handling. Provisioning
can include template/workspace compilation and is outside the cell deadline.

Legacy `compileMs` remains the build-permit/Cargo/rollback bucket; `runMs`
remains execution plus bridge cleanup. Do not add those overlapping fields to
`timings`. Execution time is not guest CPU time, and phase observations do not
measure how long a model spent reading diagnostics. Timings are recorded in
transcript details, without adding text to normal model-visible tool output.

The offline [microbenchmark](../../../poc/bench/README.md#runtime-microbenchmark)
exercises these boundaries without model calls. Full-task comparisons still
need controlled model runs; runtime microbenchmarks cannot establish D20 GO.
