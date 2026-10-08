# Agent Performance Benchmark Protocol

Date: October 8, 2026. This is the English reading edition of the original three-way design. The original was written before the runner and formal tests existed. Later implementation added cell-only rules, all-Cargo capture, and a fourth AOT group. Design requirements below are not claims that every hook or workload is implemented. See the [runner coverage](../poc/bench/three-way/README.en.md) and [validation history](benchmark-three-way-validation-2026-10-08.en.md).

Inputs: [case catalog](benchmark-three-way-plan.json), [trace schema](benchmark-trace.schema.json). The catalog keeps `executionReady: false`. The CLI creates an immutable executable manifest with actual source, build, and environment hashes. The requested model route is `anthropic/claude-opus-5-5`. Its backend revision is not independently verified. The experiment does not change the older D20/D21 acceptance rules or reuse historical measurements as new results.

## 1. Questions and variants

Measure three separate questions:

1. How do TS and Rust hosts differ in startup, prompts, streams, dispatch, and persistence?
2. How do Python and Rust/Wasm cells differ in fixed cost, computation, I/O, bridge work, and state?
3. With the same model and task, how much time and usage go to generated code, compilation, execution, repair, and checks?

| ID | Product | Host | Generated control code | Execution |
|---|---|---|---|---|
| `prime-ts` | Prime TS parent of the Rust port | TypeScript | Python | Persistent Python kernel |
| `prime-rust` | Pinned Prime Rust revision | Rust | Python | Persistent Python kernel |
| `wasmedge` | This fork | TypeScript | Rust | Release WASI build; new WasmEdge interpreter process per cell |
| `wasmedge-aot` | Added later | TypeScript | Rust | Same fork/reference code; trusted host AOT; new process per cell |

### Pinned source and builds

| Variant | Full base revision | Selection |
|---|---|---|
| `prime-ts` | `7d442aafa985f9342134fac16c2ef41f03fb45c1` | Sole parent of the Rust port; TS package 0.9.8 |
| `prime-rust` | `967eb13fd488507af5f590e9c6ea8b2672f1fc05` | Upstream revision checked at design time; commit 2026-10-07 22:04:58 UTC |
| Fork | `48d6312570f7d39809703db2c69a43f342fb7424` | Fork baseline before this experiment; later runtime patch is saved separately |

[TS source](https://github.com/PrimeIntellect-ai/prime-agent/tree/7d442aafa985f9342134fac16c2ef41f03fb45c1), [Rust source](https://github.com/PrimeIntellect-ai/prime-agent/tree/967eb13fd488507af5f590e9c6ea8b2672f1fc05), and [port commit](https://github.com/PrimeIntellect-ai/prime-agent/commit/39bc99a91d102c46474c090fdc7ae7cd5037ffcf) identify fixed inputs. The pinned [Rust kernel benchmark](https://github.com/PrimeIntellect-ai/prime-agent/blob/967eb13fd488507af5f590e9c6ea8b2672f1fc05/crates/pa-core/examples/kernel_bench.rs) launches Python. A Rust host is not native execution of generated Rust.

Product revisions also differ in features, prompts, and dependencies. An optional port-commit versus TS-parent control can study the rewrite more closely, but remains separate and does not remove every port change. Instrumented builds must save base revision, patch bytes/hash, and complete modified-source hash.

Use built TS bundles with the same Node binary and `cargo build --release --locked` for the Rust host. Do not rank a tsx development entry against release Rust. The upstream [launcher](https://github.com/PrimeIntellect-ai/prime-agent/blob/7d442aafa985f9342134fac16c2ef41f03fb45c1/prime-agent.sh) uses bundles with `--dist`. Bun [standalone builds](https://github.com/PrimeIntellect-ai/prime-agent/blob/7d442aafa985f9342134fac16c2ef41f03fb45c1/packages/coding-agent/scripts/build-binary.mjs) belong to a separate packaging lane. Installation, vendoring, and one-time host builds are setup costs. Builds of generated project code are task costs.

## 2. Three test lanes

| Lane | Model source | Work | What it measures |
|---|---|---|---|
| H: host | Local HTTP/SSE replay | Fixed response schedule, sizes, and tool contract | Host overhead, stream delivery, persistence |
| R: runtime | No model | Fixed Python/Rust programs with common output rules | Cell pipeline, language, and library costs |
| E: tasks | Paid model | Same task, fixture, and hidden checker | Quality, user wait, usage, repairs |

H/R require no paid tokens. H uses the actual provider adapter, client/daemon, and agent loop. A faux in-process provider validates instrumentation but does not replace wire replay. Preserve native prompts/tool schemas and save request hashes; requests are not byte-identical. Fix reasoning/text/argument bytes, chunks, terminal events, usage, call counts, and delays. Log actual emits and backpressure. A synthetic-context parser test is a separate control. Native cell replay measures a fixed trajectory, not host-only overhead.

## 3. Timing definitions

Record `run → turn → request attempt → tool call → cell/command → phase`, with agent and parent-agent IDs. Save start/end events, not just averages.

### Host and model phases

| Phase | Start → end | Interpretation |
|---|---|---|
| `startup.cli` | Launch → CLI accepts commands | Record packaging and runtime. |
| `startup.daemon` | Supervisor launch → protocol ready | Socket existence alone is insufficient. |
| `startup.worker` | Session request → worker ready | Includes worker boot. |
| `startup.resources` | Load start → prompts/skills/catalog ready | Split scan/read/config when observable. |
| `startup.runtime` | Provision start → first-cell readiness | Python boot or Rust scaffold; can overlap startup. |
| `host.prompt_build` | Turn dispatch → messages ready | Record bytes, entries, tokens. |
| `host.provider_prepare` | Messages ready → transport handoff | Conversion, serialization, credential lookup. |
| `provider.headers_wait` | Send boundary → headers | Upload, network, queue, prefill; not pure inference. |
| `provider.first_body_wait` | Headers → first body/SSE bytes | Requires a transport marker. |
| `provider.first_content_wait` | Headers → first nonempty content | Reasoning, text, or arguments; empty starts do not count. |
| `provider.reasoning_visible` | First → last reasoning delta | Visible window, not full internal thinking. |
| `provider.code_emission` | First → last decoded source byte | Keep original chunks and source ranges. |
| `provider.response_stream` | First content → terminal event | Parent of emission windows; do not add children again. |
| `host.stream_decode` | Chunk arrives → event/arguments ready | Per-chunk distribution; stream wait is not parser CPU. |
| `host.tool_dispatch` | Arguments ready → tool body | Validation, scheduling, serialization. |
| `host.result_pack` | Tool ends → result ready | Diagnostics, truncation, attachments, encoding. |
| `host.transcript_append` | Append starts → persistence contract met | Distinguish write, flush, and fsync. |
| `host.next_turn_gap` | Result ready → next request | Host bookkeeping; not model diagnostic comprehension. |
| `host.client_delivery` | Enqueue → complete client receipt | IPC, encoding, backpressure. |
| `task.agent_elapsed` | Submit → final required output | Excludes fixture setup, external checker, teardown. |
| `run.user_elapsed` | Cold CLI launch or warm submit → final output | Cold case includes startup without adding it again. |
| `task.check` | External checker launch → completion | Same checker; agent-run tests stay in agent time. |
| `run.teardown` | Stop request → owned tree stopped | Separate from task latency. |

Each retry has an attempt ID. Keep backoff, failed responses, HTTP status, error kind, model ID, and usage for every attempt.

### Cell and project phases

| Phase | Required detail | Scope |
|---|---|---|
| `cell.provision` | Toolchain, scaffold, skills, cache validation, history | Rust; compare with Python boot separately. |
| `cell.queue` | Runtime queue and build-permit queue | State deadline coverage. |
| `cell.source_prepare` | Backup, library edits, main write, helper index | File writing is not model generation. |
| `cell.validate` | Skill gate, library-test snapshot/build/run, policy/probe | Every Cargo call gets an ID. |
| `cell.compile` | Cargo, fingerprints, rustc units, link, diagnostics | Control-cell compilation, not project build. |
| `cell.python_prepare` | Decode, parse/bytecode, imports | Python preparation is not assumed free. |
| `cell.runtime_launch` | Spawn → guest entry | Combine load/instantiate/WASI init if hooks are absent. |
| `cell.guest` | Guest entry → exit | Inclusive wall, not CPU alone. |
| `guest.compute` | Fixed algorithm start → end | Local wall/CPU; unavailable for unmarked code. |
| `guest.input` | Read, decode, parse, index | Record bytes, records, files. |
| `guest.output` | Encode, write, flush, emit | Record hash and durability contract. |
| `guest.state` | Encode, save, load, decode | Separate memory reuse, blobs, and reparsing. |
| `bridge.roundtrip` | Send → full reply | One guest clock, method, sequence, payload. |
| `bridge.host` | Full frame → reply handed to writer | Parse, queue, handler, encode, write. |
| `cell.exit_drain` | Guest exit → process/output complete | Not guest computation. |
| `cell.rollback` | Failure → source restoration | Build/runtime failure semantics differ. |
| `cell.snapshot` | Snapshot start → contract met | Git or Python serialization; contracts differ. |
| `cell.cleanup` | Stop → cleanup complete | Handler drain/cancel and scratch cleanup. |
| `project.source_write` | Actual project-file writes | Separate from wrapper/helper source. |
| `project.build` | Native build spawn → end | Resolution, compile, link; separate from cell build. |
| `project.test` | Agent-run tests → end | Assertions, outcomes, runner startup. |
| `project.program_run` | Generated program start → end | Separate from build/test. |

Guest time includes I/O and bridge waits. Use exclusive intervals and a residual. Merge overlapping children before subtraction. Phase medians do not add to total medians.

Compiler detail has levels. Level 1 records Cargo wall/CPU, artifact freshness, and units. Level 2 uses supported [Cargo timings](https://doc.rust-lang.org/cargo/reference/timings.html), with toolchain/flags recorded. Parse, typecheck, borrowing, codegen, and link detail require separate instrumentation and an overhead audit. Parallel unit durations do not sum to Cargo wall. Missing Python hooks remain missing.

### Four meanings of “write code time”

1. `code_ready_ms`: request dispatch to complete source arguments. The design includes upstream preparation when dispatch is observable. The implemented gateway measure starts at gateway receipt and does not observe earlier prompt construction.
2. `code_emission_ms`: first to last decoded source byte. Tool JSON and source bytes are separate. Concurrent source windows require interval union.
3. `source_write_ms`: actual filesystem writing, split into cell, helper, and project roles.
4. `time_to_first_correct_artifact_ms`: submit to a predefined passing probe. No intermediate probe means only final correctness is known.

Save source bytes, provider-supplied code tokens if available, total output/reasoning tokens, attempts, compile errors, and rewritten bytes. Do not estimate billed code tokens from character ratios. If only complete tool arguments are visible, code-ready can be measured but emission is missing. Raw JSON source ranges can be mapped back to SSE timestamps; the result is a client-visible window.

Use `artifactRole: control_cell | helper_library | project_source`. Nested windows must not be added. Dynamically constructed project source has a write/hash record, not an invented model-emission timer.

### Repairs

Link related attempts with `repairChainId`: generation → write → compile rejection → diagnostics → repair request → build → runtime/test error → repair → passing checks. Save every stage, rollback, and retry. Report first-attempt success, attempts to correct, repair elapsed/tokens, and failed build/test cost. Internal model comprehension is not observable. Diagnostic-format effects need a separate randomized ablation with matched inputs.

## 4. Workloads

### Host cases

| Case | Planned parameters | Main costs |
|---|---|---|
| H01 startup/session | Cold CLI/daemon and warm new session; 0/1k/10k transcript entries | Startup, load, hydration, first response |
| H02 stream/context | Context 8/32/128 KiB; output 1/64/1024 KiB; chunks 64/1024/16384 bytes; burst/paced | Prompt, payload, decode, delivery/backpressure |
| H03 dispatch/persistence | 1/10/100 common calls; result 1/64/1024 KiB; handler 0/10 ms | Dispatch, packing, persistence, IPC, gaps |

Use registered H02 parameter combinations before a full Cartesian matrix. Report planned versus actual emit delays. Subtracting replay sleep does not isolate host overhead. H03 Rust is not applicable in the implemented matrix because it lacks a standalone bash model tool.

### Runtime cases

Both upstreams use identical Python bytes. Rust performs equivalent operations with common Unicode, sorting, overflow, and error rules. Optimized implementations are separate controls.

| ID | Planned workload/scale | Check and phase focus |
|---|---|---|
| R01 | Fixed `ok`; first and later cells | Exact output; provision/queue/compile/launch/protocol/snapshot |
| R02 | Same source, literal/helper change, empty target | Output/hash and actual cache evidence |
| R03 | uint32 loop: 10^4/10^6/10^7 iterations | Oracle checksum; compute/CPU/throughput |
| R04 | JSONL/CSV join: 1/16/128 MiB | Canonical rows/hash; read/parse/index/join/write |
| R05 | 100/1k/10k files × 4 KiB, TODO/FIXME | Sorted path/line/content hash; walk/read/search/sort |
| R06 | Exact replacement in 1/100/1k files × 4 KiB | Tree hash/count; missing match rejected; read/match/write/diff |
| R07 | Five state cells: 4 KiB/1 MiB/16 MiB | Query/hash; resident, serialized, and reparse strategies |
| R08 | Define helper, use in ten cells, then edit | Counts/version; definition/compile/reuse/invalidation |
| R09 | 1/100/1k echoes; payload 0/1/64 KiB; handler 0/10 ms | Sequence/reply hash; bridge/handler/transport |
| R10 | Common pinned shell command; 0/10/100 ms | Exit/output; bridge/launch/wait/drain |
| R11 | Save/stop/resume: 1 KiB/1 MiB/16 MiB state/helper | Restored query/hash; snapshot/stop/boot/load |
| R12 | Syntax, type/name, runtime, contract errors | Expected rejection and recovery; diagnostics/rollback/retest |
| R13 | Stdout 1/64/1024 KiB and 16 MiB file | Raw hash and truncation; emit/drain/pack/save |
| R14 | Cancel compute, handler wait, or compile; probe again | Tree stop/recovery; cancellation/drain/cleanup |
| R15 | 1/4/8 runtime sessions | All hashes; queue/slowdown/throughput/tree memory |
| R16 | 100/1k cells; state change every ten cells | Checksums/inventory; drift/history/state/RSS |

R07 strategies are separate. Rust has no cross-cell resident objects, so that strategy is not applicable. Serialized/reparse controls are comparable. R11 checks the product's actual durability, not unpromised atomic rollback. Rust/Python can reject the same error at different phases. Python compiler cancellation has no corresponding Cargo phase. Linux resource-limit ablations are separate from unrestricted comparisons.

Prebuilt Rust modules and precompiled Python code objects can diagnose R01/R03 execution. They do not replace complete tool-pipeline totals. The later AOT group reports compilation separately; it does not replace interpreter.

### Task cases

Use the existing [12 fixtures/checkers](../poc/bench/README.md#tasks-full-set-designmd-appendix-c), pinned by version/hash. Scaling and intermediate-probe variants need new task versions.

| Task | Work | Separate costs |
|---|---|---|
| 01-log-stats | Log report | Explore, code, parse/count, write |
| 02-csv-normalize | CSV to JSON | Infer schema, parse/normalize, encode |
| 03-fix-bug | Boundary bug | Read/search, edit, checks, repair |
| 04-multi-turn-state | Explore and answer later | Save, load/reread, answer |
| 05-toolchain-loop | Two bugs and test iteration | Edits, failures, repair, retest |
| 06-build-cli | Word-frequency CLI | Code-ready, write, checks, run |
| 07-todo-scan | Multi-file index | Walk, match/sort, Markdown |
| 08-rust-rename | Cross-file Rust rename | Search/edit, control-cell build, native project Cargo/tests |
| 09-helper-accumulation | Three-turn helper reuse | Helper creation/build, state, reuse, summary |
| 10-lint-fix | Lint and behavior | Lint, diagnostics, edits, tests |
| 11-join-report | JSON/CSV report | Parse/index/join, write, repair |
| 12-repair-config | Validator-compatible configuration | Read, edit, validate, retry |

Extended tasks are separate from D21: E13 a stdlib Rust streaming log CLI with empty/malformed/overflow/sort and 1/16/128 MiB checks; E14 four/eight child shards plus reduction, with parity verified first; E15 compaction/checkpoint/resume with saved helper and large-input index. Record source/build/test/run in E13, parent versus child work in E14, and context/provider/checkpoint/restore costs in E15. Do not silently alter compaction thresholds to force parity.

The implemented `cell-runtime-comparison-v1` retains native system prompts but exposes only the cell tool. Reads, parsing, calculations, edits, and writes must occur in Python/Rust APIs. Shell/subprocess delegation is prohibited. Every turn needs a successful cell. External project tests/lint run in a shared checker after agent completion, outside agent time. This differs from the older native project-test loop.

`native-tool-choice-observation` records normal tool choice separately. Bash-only trajectories cannot answer the cell comparison. Keep original records, but exclude them from cell latency. Prompts, inputs/hashes, and policies are not pooled. Even cell-only model tasks retain prompt/schema differences; R isolates fixed code more closely.

## 5. Cache and controls

| Condition | Required state |
|---|---|
| installed-fresh-session | Installed tools/dependencies; fresh agent/session/workspace; no worker; template warmth recorded |
| active-session | Same worker/runtime after a passing cell; preserve namespace/target |
| empty-cell-target | Delete only this run's target; retain vendor/toolchain; not applicable to Python |
| artifact-reuse | Same bytes and actual compiler freshness evidence |
| checkpoint-restored | Save, stop, open a new worker from saved state |
| setup-empty | New install/cache roots; network/setup measured separately |

Rewriting the same `main.rs` and copying a template target do not prove cache hits. Record Cargo freshness, rustc counts, fingerprints, paths, mtimes, and compiler version.

Use one host per platform, fixed binaries/hashes, AC power, and recorded load. Pin compatible Python executable/dependencies for controlled H/R; otherwise disclose product defaults. Fix route/model/settings/retries where possible and mark unknown backend details. Keep native prompts, schemas, and actual cache usage. Generate identical fixture bytes/permissions from a seed and validate both references first.

Isolate each run's agent directory, socket, session, project, runtime, and logs. Keep driver setup/hash/check/teardown separate from product latency. Do not run the main latency campaign concurrently. Counterbalance variant order with a fixed seed; the original three-way design uses six permutations. A four-way plan must record its own order. Preserve within-case cell dependencies. Do not clear user or system-wide caches. Record OS/cache/load/thermal conditions; empty target is not cold OS.

## 6. Trace and resources

Each planned slot has a manifest entry before launch. Save source/collector patches and fixtures. Per run, preserve metadata, incremental events, normalized spans, requests, cells, commands, resources, checks, stdout, and stderr. Export run/phase/cell/request CSV plus filterable HTML. Every aggregate must lead back to samples.

Fields include IDs for run/variant/case/agent/turn/attempt/tool/cell/command/repair/span/parent/process/clock, decimal-string monotonic timestamps, duration, state, outcome, attributes, and counters. The [schema](benchmark-trace.schema.json) checks structure. Separate checks validate IDs, parent graphs, clocks, coverage, and duration consistency.

| State | Meaning |
|---|---|
| `measured` | Real timestamps/duration, including failed work |
| `not_applicable` | Product has no such phase |
| `not_run` | Phase did not occur, such as execution after compile rejection |
| `missing` | Phase/hook record unavailable |
| `incomplete` | Start observed, end absent after crash/abort |

Do not replace these states with zero. Use an expected-phase inventory, not only observed spans, for coverage. Keep clocks local unless calibrated with uncertainty. UTC is provenance. Do not subtract unrelated monotonic origins. Calibration uncertainty larger than a phase blocks a cross-process ranking. Background work needs causal links and settled boundaries. Report inclusive wall, exclusive wall, CPU work, and critical-path waits separately. Preserve unattributed time.

Planned resource counters include exited-child user/system CPU, peak RSS, spawn/thread counts, and sampled concurrent tree RSS every 10 ms. Individual child peaks do not sum to a tree peak. Linux charged cgroup memory differs from RSS. Missing macOS equivalents stay unavailable. Record input/output, files, records, artifacts, caches, state, and transcript size. Wall minus CPU is not exact I/O wait. perf/strace and CPU profiles belong in separate audited profiling lanes. Current campaigns do not have complete resource coverage.

## 7. Statistics and scoring

The original sampling design calls for five warmups and 100 operations within each of at least ten independent warm session blocks. Fresh startup, empty target, and restore need at least 30 independent samples without warming away the intended condition. Stateful R07/R08/R12/R15/R16 use ten independent trajectories per parameter case; R14 uses 30 cancellation samples. Cells within a session are not independent sessions.

The original three-way plan described 12 smoke runs, 324 pilot runs (12 tasks × 3 variants × 3 model roles × 3 repetitions), and 1,080 formal runs at ten repetitions. The requested single-Opus four-way plan is 16 smoke, 144 pilot, and 480 formal runs. Do not confuse these matrices. D21 model roles remain a separate legacy requirement. Pilot variance sets the formal count before execution.

Report median, mean, range, IQR, n, and 95% intervals when supported. Small per-task samples do not support reliable p95/p99 claims. Seeded paired bootstrap must preserve tasks, matched blocks, variants, and all cells within sessions. Separate model/platform/cache strata. Give tasks equal weight.

Report a quality/cost vector: correctness and repairs; user wait; code-ready/emission/write and usage; cell/project/gate compilation; execution and bridge; host costs; persistence; CPU/memory/storage and actual billed cost when available.

```text
latency_score(v, k) = 100 * median_ms(prime-ts, k) / median_ms(v, k)
throughput_score(v, k) = 100 * throughput(v, k) / throughput(prime-ts, k)
quality_score = 100 * passed_runs / attempted_valid_runs
```

Only score matched work/scale/cache/model with complete coverage and positive denominators. Scores can exceed 100. A missing or zero baseline is unavailable. Python does not receive infinite speed for having no Cargo. Runtime references must pass all oracles before a speed score.

Keep actual outcomes for all valid attempts, successful-only latency with its survivor count, and predefined-budget penalized latency. Failures/timeouts use the registered task budget; do not choose it after results. Infrastructure errors do not count as model failures but block matrix completeness. Missing slots, trace gaps, or source drift block formal verdicts. Reruns need new attempts and retained old evidence.

A single speed ratio, if needed, uses equal-task-weight geometric means of penalized median ratios, separately per model, with quality and confidence intervals. Overlapping phase scores are not a total-performance score. D20/D21 retain their original 12-task evidence and pass/token rules. Prime Rust is not legacy group A; the old A/B/F analyzer needs explicit compatibility handling.

## 8. Implementation sequence and coverage

Reusable components are the [cell timing code](../packages/coding-agent/src/core/rust-cell/cell-timing.ts), [Rust tool](../packages/coding-agent/src/core/tools/rust.ts), [request timing](../packages/coding-agent/src/core/request-timing.ts), [offline microbenchmark](runtime-microbenchmark-2026-10-07.en.md), and [older harness](../poc/bench/README.md).

Required work includes release adapters and readiness/parity checks; normalized traces and clocks; Python/Rust runtime hooks; source-field SSE mapping; process accounting; and explicit missing-phase coverage. Legacy `compileMs` includes build-queue work and sometimes rollback. Legacy `runMs` includes cleanup. They cannot be added to their child phases or called pure compiler/guest time. Arbitrary unmarked model code gets observable totals, not invented body partitions.

| Stage | Output | Gate |
|---|---|---|
| P0 | Pins, release builds, adapters | Complete fingerprints/settings and parity |
| P1 | H replay, traces, filters | Oracles, phase inventory, partial-event detection |
| P2 | R references, oracles, cache setup | Equivalent outputs and expected failure/recovery |
| P3 | Paired instrumentation on/off audit | Primary-latency overhead 95% upper bound ≤2% |
| P4 | Smoke/pilot, usage, variance | Freeze changes in a new plan before formal execution |
| P5 | Complete formal matrix | Source stability, complete checks/traces, intervals and failures |

Report absolute overhead too. Very short no-op cases can make percentages unstable. Unproven hooks remain diagnostic. Do not subtract estimated overhead from primary results. Save normal and failed evidence with checksums. Keep sensitive payloads in restricted archives. Clean only benchmark-owned processes/workspaces.

The first useful order is H01/H03 → R01/R02/R09 → E03/E08/E09/E11, then larger data, long sessions, and concurrency.

## 9. All-Cargo, cell, and AOT additions

The later all-Cargo wrapper captures initialization, skill probes, cells, gates, checker builds/tests, helper commands, and retries through the pinned runtime's PATH and `WASMEDGE_AGENT_CARGO` entries. It saves command ledgers and three child-clock samples. Incomplete endpoints, duplicate IDs, bad clocks, or absent legacy capture make deductions unavailable. Custom absolute paths outside these entries are outside verified capture coverage.

`run.validated_elapsed` covers initialization to checker completion, excluding benchmark setup and teardown. User ends at agent completion. Agent excludes daemon and checker. Merge command intervals, clip to the selected period, then subtract once. Do not add cell.compile or rustc children. Raw and adjusted medians use identical eligible samples. Wrappers leave startup overhead in the remainder. This is arithmetic, not a rerun without Cargo.

Cell views use `cell.python_execute` and `cell.execution`, not buffered client tool-event windows. They show calls, success/runtime/compile failures, totals, successful-cell averages, and failed execution. Compile failures have no runtime duration. Runtime failures remain in successful task trajectories. Parallel totals measure work. Python 0 ms is below resolution. Boundaries include each runtime's launch/I/O/bridge costs.

The AOT addition keeps interpreter as a separate group and compiles verified, stripped Wasm on the host for every cell. Capture `cargo.command` and `aot.command` separately. Combined deductions use interval union. Missing AOT capture is not zero. The current product has no AOT cache. See the [AOT/bridge report](benchmark-aot-bridge-2026-10-08.en.md) for the measured implementation.
