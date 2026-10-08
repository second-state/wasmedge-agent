# WasmEdge Agent Feasibility Report

Date: August 6, 2026. English reading edition prepared October 8, 2026.

This study assessed replacing Prime Agent's persistent IPython runtime with Rust cells compiled and executed in WasmEdge. The source was Prime Agent v0.7.0 at `c22549a3`, under the MIT license. Local tests used Apple Silicon macOS, Darwin 25.5.0, rustc 1.97.0, and a local WasmEdge 0.17.1 master build.

**Historical scope:** Sections 3–5 describe candidate designs and plans, not a list of shipped features. Source analysis applies to the pinned upstream revision. The small program test is separate from the [August 10 benchmark](docs/benchmark-comparison-2026-08-10.en.md), which used WasmEdge 0.14.1. Current implementation details are in the [English runtime reference](packages/coding-agent/docs/rlm-runtime.md). Current results are in the [October consolidated report](docs/rust-cell-report-2026-10-08.en.md).

## 0. Executive summary

The compile-run prototype was feasible. Rust provides compile-time checks. WasmEdge provides a basis for isolated guest execution. Network policy, resource limits, and replay require a concrete runner and host design; the prototype alone did not prove them.

The tradeoff is a change from a live REPL to **one cell = one complete program**. Explicit files and reusable source replace the arbitrary in-memory namespace.

Four findings supported further work:

1. A representative small release program compiled in 0.28 s with a warm target, executed with state round-trip in about 10 ms, and took 4.8 s for a cold dependency build. These are local program measurements, not fixed per-cell guarantees.
2. The SDK has a custom-runtime entry, but host bridge, goals, prompts, skills, and rendering have deep Python coupling. A prototype can use the SDK; a complete product needs a fork or equivalent core changes.
3. Most provider, loop, TUI, daemon, session, and compaction code can be reused. The concentrated runtime-specific code is the kernel, tool, prompt, skills bootstrap, and renderer.
4. Persistence needs a new model: a session Cargo workspace, reusable `agent_lib` source, explicit serialized state, and a host bridge. Recovery depends on successful writes, file integrity, and format compatibility.

The recommended route was SDK prototype first, runtime-swap fork second, and a new Rust-native host only as a later strategic option. The largest uncertainty was whether models could work efficiently under the complete-program cell model.

## 1. Prime Agent source analysis

### 1.1 Product and origin

Prime Agent is a coding/research agent built around a persistent IPython scratchpad and a continual harness. The RLM model treats context and tool calls as program data and functions. The harness saves supplemental prompts, memory, skill references, and child specifications; `/refine` applies evidence-based edits without changing the base system prompt.

At the studied revision, Prime Agent was an in-repository fork of pi-mono. Four packages retained the pi package names. That established a practical example of keeping an existing host while replacing its execution model.

The pinned README says generated Python and project commands run with user permissions. Worker/kernel separation helps lifecycle and recovery; it is not a security sandbox. This distinction motivates an explicit guest permission boundary.

### 1.2 Repository size

| Area | Role | Approximate TS/Python lines |
|---|---|---:|
| `packages/ai` | Nine API implementations, 32 provider definitions, normalized streaming | 34,013, including about 20k generated model lines |
| `packages/agent` | Agent loop, tools, queues, events | 2,395 |
| `packages/coding-agent` | Daemon, worker, kernel, sessions, skills, harness, UI and protocols | 115,565 |
| `packages/tui` | Terminal UI framework | 14,927 |
| Python runtime shim | Bridge, harness store, skill adapter | About 1,205 |

The repository also had 33 documentation files and 13 bundled skills. Node required version 22.8 or later; uv managed Python 3.11. The thin Python shim left authority in the TypeScript host, which made the guest-language swap practical.

### 1.3 Processes

TUI, print, JSON, and RPC clients connect to a daemon supervisor. A session worker owns the root session tree, scheduler, agent session, root Python kernel, and child runtimes. The host manages providers, queues, tools, compaction, goals, children, and transcripts. The kernel is a separate process. Detached sessions can continue under the daemon.

### 1.4 The built-in Python tool

The default model-visible built-in tool was `ipython`, with `code: string` and sequential execution. Reads, edits, shell magics, skills, children, and context operations all used Python cells. Variables and imports remained alive. Tool output combined stdout, stderr, results, and tracebacks, with each stream truncated at 65,536 characters. Attachments carried image MIME blocks. A reset notice told the model to rebuild lost state.

### 1.5 Kernel transport

KernelManager implemented Jupyter wire protocol 5.3 over ZeroMQ, with HMAC-SHA256 and loopback ports. Shell carried execution, iopub carried output/status/comms, and control carried interrupt/shutdown and host replies. Promise chaining serialized cells. A busy-kernel recovery path sent interrupts every 500 ms for up to five seconds before offering wait or restart.

Linux used a fork-server optimization with preloaded modules and `gc.freeze()`. Custom MIME output supported diffs, attachments, and agent messages. A runtime owned by the project could replace much of this Jupyter-specific transport with a smaller request/reply protocol.

### 1.6 Host bridge

The Python shim opened a `host.request` comm. The host dispatched JSON by method to `HostRequestHandlers`: children, models, goals, messages, compaction, refinement, heartbeat, observation, and MCP. Replies used the control channel because replying on the serialized shell channel during a cell could deadlock. Python used thread-safe event-loop delivery.

The handler registry was language-neutral. `rlm.run` was admission-only: it returned a spawn handle immediately, not the child's answer. Children returned results through messages or files. Host child state survived kernel resets and compaction.

### 1.7 Bootstrap and skills

uv prepared Python 3.11, a kernel environment, ipykernel, the runtime shim, dill, HTTP/config packages, and common data libraries. A schema-8 bootstrap marker hashed runtime/skill inputs and triggered rebuilds. Python skills used editable installation and pre-imported callable module wrappers. On resume, dill restoration occurred before fresh runtime/skill handles were installed.

### 1.8 Persistence

Compaction changed conversation messages while the live kernel remained. The host reported surviving names to the model. Resume used best-effort dill snapshots after successful execution, debounced by 1.5 s. Top-level names were serialized individually, with exclusions and a 256 MiB cap. A failed variable did not block others. Open files, sockets, threads, and unserializable objects were not preserved.

Explicit Rust files avoid arbitrary object snapshots, but still require write/recovery/compatibility checks. They do not make all persistence failures disappear.

### 1.9 Prompts

Prompt construction combined the base RLM prompt, child guidance, harness entries, tool guidelines, project context, skill metadata, and appended content. The fixed body was about 10–11 KB or 2,600–2,800 tokens; skills/harness could bring it to 15–20 KB. Python-specific guidance covered REPL state, magics, package installation, and async calls.

A Rust prompt must teach a new programming model. The existing separation between the scratchpad and the target project's native environment remains useful.

### 1.10 Skill types

Markdown skills supplied instructions. Python-backed skills supplied installed callable code. Host-bridge skills were thin wrappers around host authority. Metadata appeared in the prompt; full files were read on demand. Only edit, image attachment, and websearch had substantial Python work among the bundled skills. Most other behavior could move to Rust wrappers or remain in the host.

### 1.11 Harness and refinement

The schema-1 harness stored prompt, memory, skill, and child entries plus refinement history. Local/global stores synchronized by file metadata. `/refine` used a separate model pass over up to 80k trajectory characters, with a 32k-token output cap and thinking off. Strict JSON edits used optimistic concurrency and before/after snapshots. Base-system-prompt edits were rejected.

Auto-refine ran after 25 assistant turns or compaction, subject to root-only and 20-minute cooldown rules. Skill references required the Python discriminator in both host and shim; Rust would need an additional value. The core store and edit protocol were otherwise reusable.

### 1.12 Extension limits and fork cost

Custom tools, `baseToolsOverride`, active-tool control, prompt replacement, extension dependencies, and custom providers made an SDK prototype possible. Four gaps blocked a complete extension-only product:

| Gap | Effect |
|---|---|
| Host handlers wired only to the Python provisioner | Custom runtime could not access core child/goal/message/MCP operations. |
| Unconditional Python prompt lines | Disabling ipython did not remove all Python guidance. |
| Goals required/re-enabled ipython | Goal management conflicted with a custom runtime. |
| Executable skill contract was Python-only | Custom runtime lost skills and their creation loop. |

Rendering, compaction notices, installation, CLI help, and environment names added further coupling. Runtime-specific replacement was estimated at about 7.7k TS lines, 2.2k Python lines, 965 skill lines, and 3.8k test lines. Shared-file changes affected roughly 6k lines scattered through larger modules. An estimated 90–92% of the codebase was reusable. These were source-based planning estimates, not a measured migration percentage.

## 2. Mapping Python cells to Rust/Wasm

### 2.1 and 2.2 Required capabilities

| Python capability | Proposed Rust/Wasm counterpart | Tradeoff |
|---|---|---|
| Fast dynamic evaluation | Release compile/run and compiler diagnostics | Compile and repair costs need measurement. |
| Persistent namespace | Workspace source, explicit state, complete programs | Fundamental semantic change. |
| Best-effort dill resume | Serialized files and defined schemas | Recovery path still needs checks. |
| Dynamic package ecosystem | Validated prelude, Cargo manifests, vendoring | Smaller WASI-compatible ecosystem. |
| Shell magics | Separate host bash/exec | Explicit host permission boundary. |
| Jupyter host comm | Host functions or request/reply bridge | Reuse handler registry. |
| Callable skills and introspection | Skill crates, re-exports, rustdoc | Typed APIs, slower edit/build loop. |
| Rich MIME output | Guest emit API routed to the same UI | Preserve display behavior. |
| Interrupt/restart | Process kill or runtime cancellation, gas, pages, timeout | Distinct controls need implementation. |
| Async expression calls | Synchronous `Result` APIs with admission-only spawn | Preserve call semantics with new syntax. |

### 2.3 Complete-program cells

The proposed runner writes each complete `fn main()` into a session workspace, compiles it, runs it, and returns output. It does not use a Rust REPL to move arbitrary variables between Wasm instances. Helpers remain in `agent_lib`; small values use serialized state; large data remain in files. Exploration requires a small program, so templates and high-level helpers are important.

### 2.4 Local prototype measurement

The small program scanned a mounted directory and read/updated a serde JSON state file:

| Item | Value | Condition |
|---|---:|---|
| Cold dependency build | 4.80 s | Release `wasm32-wasip1`, including serde/serde_json |
| Warm build after main edit | 0.28 s | Warm target directory |
| Interpreter execution | 0.01 s | Includes state round-trip |
| Artifact size | 206 KB | Release, without strip/wasm-opt |
| State persistence | Passed | Correct accumulation over two executions |

This does not cover the agent, queues, bridge handlers, model requests, or repairs. No adequate latency distribution was collected. Cache changes can trigger rebuilds. The 10 ms is not isolated instance startup, and 206 KB is not a general cell size.

### 2.5 Benefits and unproven goals

Preopens can restrict guest files. The original socket design did not enforce fine-grained network egress. Compiler/bash/handlers were outside the guest. Rust diagnostics can reject some mistakes before execution, but not incorrect business logic. Replay needs files, time, randomness, external replies, and concurrency order; Wasm/Git alone are insufficient. Gas, page caps, cancellation, and deadlines have different scopes. Deployment footprint, concurrency density, and local LlamaEdge/WASI-NN integration were not measured.

### 2.6 Costs

The study expected extra compile/repair turns and token cost; Phase 0 had to measure them. Python's data-science ecosystem was stronger. WASI compatibility excludes or constrains native dependencies, mmap, and some async features. Shell convenience and live introspection need alternatives. Initial positioning favored coding/systems tasks rather than replacing all Python research workflows.

## 3. Candidate runtime design

### 3.1 Architecture

Keep the TS daemon, worker, providers, session loop, queues, compaction, goals, children, and handler registry. Replace the kernel with workspace/build/execution management and output streaming. A thin Rust `rlm` crate exposes spawn, model lookup, messaging, goals, state, harness, diff, and attachment APIs. The host remains authoritative.

### 3.2 Workspace and state

Each session keeps a Cargo workspace with `agent_lib`, a rewritten `cell/src/main.rs`, `state/`, and `target/`. The proposed offline release pipeline mounts the project, state, and scratch directories. Build errors become model-visible diagnostics. Small data use state; reusable logic uses library source; large data stay in files. Compaction can report state keys and library APIs.

These were candidate interfaces. Later implementation uses `/agent/state`, `/agent/lib`, declarative library edits, and read-only guest library mounts. Use the current runtime reference for exact APIs.

### 3.3 Transport options

| Option | Mechanism | Assessment at study time |
|---|---|---|
| T1 | Stock CLI and loopback WASI socket bridge | Fastest prototype; no fine-grained guest network policy. |
| T2 | Small embedded WasmEdge runner with host functions and host IPC | Intended final form for explicit capabilities and resource controls. |
| T3 | WasmEdge plugin with host functions | Additional plugin deployment surface. |

The study recommended T1 first and T2 later. The later product switched CLI transport to private stdio and import-denied guest networking. That update is documented separately.

### 3.4 Skill crates

Replace Python packaging with `SKILL.md`, `Cargo.toml`, and `src/lib.rs`. Mount/re-export through `agent_lib`, inspect via rustdoc, and rebuild after edits. Tests should run in the guest rather than executing generated native tests on the host. Host-bridge skills become `rlm` modules. Harness references gain a Rust discriminator.

### 3.5 Trust boundary

The guest runs agent computation within configured mounts. Native project commands use a separate host bash tool. Host bridge operations use host permissions. This is not a whole-agent sandbox. Compiler scripts/macros also require separate controls. Replay remains a goal requiring more recorded inputs.

### 3.6 Prompt rules

Teach complete programs, explicit state, reusable library helpers, large-data files, the target-project environment, `Result` calls, admission-only children, controlled dependencies, and Rust skill references. General frontier models need a new prompt. The design does not assume access to models trained on Prime's Python-specific prefix.

## 4. Route selection

| Route | Time estimate | Strength | Main limit |
|---|---|---|---|
| A: runtime-swap fork | 4–8 weeks after prototype | Reuse host features and add full wiring | Upstream sync cost |
| B: extension/SDK prototype | 1–2 weeks | Low-cost model/runtime experiment | Core bridge/goals/skills/rendering gaps |
| C: new Rust-native host | 3–6 person-months for headless MVP | Independent architecture and local inference integration | Rebuild mature providers, sessions, daemon, UI, and protocols |

Fork work replaces the kernel/shim/tool/prompt/rendering, then updates registration, session wiring, skills, harness, and installation. Most host code remains. A full mature host rebuild is much larger than the headless estimate. The recommendation was B → A, retaining C if strategic goals or sync costs justified it. These estimates were planning assumptions, not delivery promises.

## 5. Phased plan

| Phase | Proposed work and exit |
|---|---|
| 0, 1–2 weeks | SDK Rust-cell prototype; compare model success and token cost. Gate: success at least Python minus 15 percentage points and token ratio below 2×. |
| 1, 4–8 weeks | Fork runtime, bridge/children, bash, Rust rendering, prompt, state/compaction notices, installer, vendored prelude. Exit: use the agent to develop itself. |
| 2, 6–10 weeks | Skill crates, harness/refine, goals/heartbeat/observation/MCP, resource-controlled runner, artifact reuse, resume, platform review. |
| 3, ongoing | Replay inputs, local inference, Component Model evolution, and server deployment studies. |

Replay, artifact caching, deployment density, and local inference were goals, not measured benefits. The main target was stable `wasm32-wasip1` core modules; Component Model was a later option.

## 6. Risks and open questions

| Risk | Impact | Validation/mitigation |
|---|---|---|
| Model efficiency with Rust | High | Measure first errors, repair turns, and tokens; use a validated prelude/helpers. |
| Data-science ecosystem gap | Medium | Start with coding/systems; validate WASI libraries explicitly. |
| Crate compatibility | Medium | Maintain a tested dependency set and host policy. |
| Upstream synchronization | Medium | Separate exclusive directories and enumerate shared-file patches. |
| Concurrent compilation | Low–medium | Per-session targets and a global permit gate. |
| Overselling isolation | Communication risk | Document guest/compiler/host/bash boundaries. |
| Loss of Python-trained model assumptions | Medium | Test multiple model families with a new prompt. |
| Component Model schedule | Low | Do not depend on it for the core design. |
| T1 network policy | Transitional risk | Move to an enforced guest network boundary. |
| Windows coverage | Low initially | Begin with macOS/Linux and assess separately. |

Open decisions at study time were product identity/upstream relationship, Rust-only versus more Wasm languages, model budget, and writable project versus read-only plus explicit patch application. Later decisions are in the [English design guide](DESIGN.en.md).

## 7. Appendices and reproduction

### Source index at the pinned revision

| Component | Approximate source size / location |
|---|---|
| Kernel manager | 1,529 lines; upstream kernel index |
| Kernel bootstrap | 929 lines; fork-server support 363 + 148 |
| State snapshot | 297 lines |
| Python tool/bootstrap injection | 708 lines |
| Runtime prompt | 199 lines |
| Host-request dispatcher | 242 lines |
| Agent session | 11,188 lines; 85 Python coupling sites |
| Skills | 633 lines |
| Refinement / Python harness | 1,017 / 820 lines |
| Extension API / documentation | 1,523 / 2,589 lines |
| Sandbox extension example | 321 lines |
| Python guest shim | 347 lines |
| Agent loop / agent | 986 / 613 lines |

These locations describe the historical upstream, not files to restore in the runtime-swap fork.

### WasmEdge version context

The study recorded public 0.16.0 (December 30, 2025), earlier 0.15.0 feature work, and the local 0.17.1 build used in its test. These are historical notes, not a current latest-version claim. Component Model, GC, backend, and C API changes were context for future work. The core design did not require Component Model support.

### Prototype command

```sh
cargo new cell-bench
cd cell-bench
cargo add serde --features derive
cargo add serde_json
# Implement the directory scan and JSON state read/update in main.rs.
time cargo build --release --target wasm32-wasip1
time wasmedge --dir /workspace:$PWD/ws target/wasm32-wasip1/release/cell-bench.wasm
```

The measured cold/warm builds were 4.80/0.28 s and execution about 0.01 s. State accumulated across two runs. The study also drew on earlier local Component Model and agent-os architecture investigations. They were design references, not additional benchmark samples.
