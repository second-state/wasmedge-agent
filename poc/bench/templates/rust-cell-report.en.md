# Rust Cells: Safety and Performance Report

Date: October 8, 2026. This report compares Prime Agent with a TypeScript host and Python cells, Prime Agent with a Rust host and Python cells, and wasmedge-agent with Rust cells in WasmEdge interpreter and AOT modes. It separates the latest four-way tests from earlier diagnostic tests.

[Download the offline English report package](assets/rust-cell-report-2026-10-08/english-report-set.zip). Extract it and open `docs/rust-cell-report-2026-10-08.en.html`. It includes the English readers, saved dashboards, charts, and linked CSV tables. Raw request, SSE, and source links require the original local run directories, which are not committed.

**Rust cells let us check generated code before execution, run it with explicit guest permissions, and save reusable code and state as files.** AOT and the bridge update reduce some execution costs. Total task time still depends on compilation, startup, model output, retries, and the workload.

The latest fixed-program test passed 72/72 runs. The latest Opus 5.5 test passed 16/16 runs. Each run passed its output checks and cell-use rules. These results include the cost of retries, compile errors, and runtime errors. Safety claims come from the implemented controls and negative tests. Task pass rate is not a safety score.

## 1. Value and evidence

| Value | Supported claim | Evidence and limits |
|---|---|---|
| Limit generated code | The guest can use only allowed WASI imports and explicit directory mounts. Direct socket imports are rejected before execution. | Real WasmEdge tests reject `sock_open` in both modes. Host handlers have separate permissions. |
| Reduce credential exposure | The guest receives only selected environment variables. Cargo and the AOT compiler use an environment allowlist. | Environment and compiler tests. Without the Cargo sandbox, the compiler can still read host files and Cargo configuration. |
| Bound guest execution | The runner can limit gas, linear memory pages, and cell time. Invalid settings fail closed. | Gas and memory-growth tests in both modes. Gas and page caps require configuration. They do not cap total process-tree RSS. |
| Find errors before execution | Rust checks types, borrowing, and ownership before running the guest. A failed build does not run the new cell. | Compiler diagnostics, source restoration, and saved repair attempts. A successful build does not prove correct task logic. Repairs can add model calls. |
| Save reusable code | Helpers remain as `agent_lib` source. State is saved explicitly. Successful cells attempt workspace Git snapshots. | Workspace, library-gate, and snapshot implementation. No persistent object namespace, atomic rollback of external effects, or bit-for-bit replay guarantee. |
| Reduce selected execution costs | AOT reduces interpreter costs for JSON and regex work. Readiness-based bridge reads reduce polling delays. | Fixed-program comparisons and alternating bridge tests. Cargo, AOT, and new-process costs remain separate. |

The supported product claim is: **Rust cells are inspectable execution units with explicit guest permissions and saved code and data. WasmEdge AOT provides a way to reduce compute-heavy execution costs. The bridge update has reduced request/reply delays.** These tests do not show that all Rust tasks are faster, use less memory, or cost less in model fees than Python tasks.

## 2. Four architectures

{{variants}}

The Prime Rust port changes the host language. It still runs Python cells. wasmedge-agent still has a TypeScript host. The main runtime comparison is a persistent Python kernel versus Rust/Wasm cells. The latest interpreter and AOT groups use the same fork build and updated bridge. Only the runtime mode differs.

Python reuses its kernel and in-memory objects. Each Rust cell is a complete program in a new WasmEdge process and VM. Helpers, state, and project files persist on disk. This makes saved content explicit. It can also require each cell to reload data or rebuild JSON and regex structures.

![Guest permissions and trust boundary](assets/rust-cell-report-2026-10-08/boundary.svg)

## 3. Safety controls

### Default and optional controls

| Control | Default or setting | Scope | Validation and limits |
|---|---|---|---|
| Non-network WASI import allowlist | Default | Direct guest sockets, plugins, and unknown import modules | Inspection does not instantiate the guest in Node. Rejection occurs before guest execution. |
| Explicit directory mounts | Default | `/workspace`, `/agent/state`, `/agent/lib`, `/scratch` | Project files are writable by default. The guest library mount is read-only. Library edits use the host tool's `lib` argument. |
| Read-only project | `workspaceWritePolicy: "ro"` | Guest writes, deletes, and renames in the project | Real WasmEdge negative tests. Mount overlap, symlink, and colon checks prevent writable aliases. This does not restrict host handlers. |
| Host-store separation | Default mount checks | Overlap between writable mounts and harness stores | Existing ancestors and symlinks are checked. Arbitrary host hard links and concurrent filesystem races are outside this coverage. |
| Compiler environment allowlist | Default | Inheritance of ambient credentials, flags, and wrappers | This is not a compiler filesystem sandbox. Existing files and artifacts are not cleared. |
| Cell timeout | Runner cell budget | Compilation, AOT, execution, and bridge work for the cell | Runner queue and workspace provisioning are outside this deadline. Completed host-handler effects are not reversed. |
| Guest gas and memory pages | `cellGasLimit`, `cellMemoryPageLimit` | Guest instruction cost and pages per linear memory | AOT uses `--interruptible` and gas instrumentation when needed. These limits do not cover the compiler, host, or whole agent tree. |
| Cargo process sandbox | Linux `cargoSandbox: "bubblewrap"`; off by default | Compiler file access, build scripts, procedural macros, `include_str!`, and build networking | Fails closed when unavailable. Not enabled in this macOS test. Host-managed vendoring has a separate network policy. |
| Process and tree limits | Linux `processLimits`, `treeProcessLimits`; off by default | Charged memory, CPU bandwidth, processes, and threads of managed descendants | Requires cgroup v2, systemd, and Bubblewrap. Excludes the Node host, bash, and host handlers. No disk quota. |
| Trusted AOT artifact | `runtimeMode: "aot"`; interpreter by default | Guest-supplied native payloads that could bypass Wasm inspection | Inspect imports, strip custom sections, compile on the host, verify core Wasm and native payload, and save SHA-256 provenance. No AOT cache. |

At both pinned Prime revisions, the README states that generated Python and project commands run with user permissions. Separate workers and kernels help recovery; they do not provide a security sandbox. The measured kernel startup also copies the parent environment. Python can use an external sandbox. This comparison concerns these pinned product configurations.

Rust ownership checks reject some errors at compile time. See the [Rust ownership documentation](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html). Python also manages memory. A claim that Python lacks memory safety would be incorrect. Guest permissions mainly come from the Wasm/WASI configuration and runner policy. [WASI describes a capability-based security model](https://wasi.dev/). Rust itself is not an OS sandbox. Unsafe code, native dependencies, compilers, runtimes, and host handlers remain part of the trust boundary.

### Rechecked safety evidence

{{validation}}

On macOS, real WasmEdge tests passed for socket-import rejection, gas exhaustion, memory growth limits, large UTF-8 bridge messages, and a fresh handshake after timeout in both modes. The read-only project test used interpreter mode. Unit tests also cover environment rules, import rules, mount aliases, AOT stripping, provenance, and failure handling.

Real Linux Bubblewrap and cgroup tests were skipped because the platform requirements were absent. The macOS results do not prove Linux enforcement. See the [runtime trust boundary](../packages/coding-agent/docs/rlm-runtime.md#trust-boundary) for full settings and excluded host paths.

## 4. Fixed-program execution

The latest test has 6 cases × 4 variants × 3 repetitions. Both Wasm modes use identical Rust reference source. Python performs equivalent operations under the same output contract. This removes model-generation variance. It still includes differences between languages and libraries.

Values below are the median of three per-run cell execution totals, in milliseconds. **They exclude Cargo, AOT compilation, initialization, and snapshots.** Rust execution includes the new process, module load, VM, guest, bridge, and output drain. Python uses an existing kernel. A reported 0 ms is below its integer-millisecond resolution. R01 and R04 each have two cells.

![Four-way fixed-program cell execution](assets/rust-cell-report-2026-10-08/runtime-linear.svg)

{{runtime}}

Data join fell from {{join_before}} ms in interpreter mode to {{join_after}} ms in AOT mode, a {{join_reduction}}% reduction. Repository scan and bridge execution also improved. The short CPU case still took {{cpu_aot}} ms in AOT, versus {{cpu_python}} ms in each Python kernel. A new process and VM impose a fixed cost on every Rust cell. The results support choosing a mode for the workload.

Earlier diagnostics confirmed that Python JSON uses the `_json` C accelerator. Rust `serde_json` runs as interpreted Wasm in interpreter mode. A near-empty process took about 8–10 ms. Guest work can be short while cell time remains limited by launch and load costs. The [earlier runtime analysis](benchmark-cell-runtime-analysis-2026-10-08.en.md) contains CPU, JSON, regex, and state body timers. Its AOT and 1 ms polling tests were diagnostic controls before the product update. See the [AOT and bridge report](benchmark-aot-bridge-2026-10-08.en.md) for the implemented update.

## 5. Controlled bridge comparison

The test used identical `diff.rs` and `bridge.rs` source bytes, the same handlers, and a 1 KiB payload. It alternated old polling, readiness-based interpreter, and readiness-based AOT execution. Each mode and case had two warmups and 15 measured samples. All 102 samples were saved. The chart and table use only measured-sample medians.

![Alternating bridge comparison](assets/rust-cell-report-2026-10-08/bridge.svg)

{{bridge}}

For 100 echoes, process wall time fell from {{bridge_before}} ms to {{bridge_after}} ms after the readiness update, a {{bridge_reduction}}% reduction. Normal WASI reply reads now use `poll_oneoff` to wait for stdin readiness or a monotonic deadline. They wake when data arrives. Native TCP and rare write retries keep their existing polling.

AOT reduced the total further to {{bridge_aot}} ms. Guest-body medians for 100 echoes were 639.344 → 53.548 → 3.207 ms. After removing polling waits, interpreter execution and JSON framing still have measurable costs. We do not pool these results with earlier bridge tests under different scheduling conditions.

AOT compilation took another 2.74/2.76 seconds before execution. If a future trusted artifact cache allowed reuse, this fixed 100-echo workload would need about **51 executions** to recover one 2.76-second compile cost at a saving of about 54.57 ms per execution. This is an arithmetic estimate under a reuse assumption. The current product recompiles every cell and does not receive this benefit.

## 6. Opus 5.5 task results

The test has 4 tasks × 4 variants × 1 repetition. All 16 runs passed the common checker and per-turn cell rules. There were 70 paid model requests. The route was `anthropic/claude-opus-5-5`, with reasoning off. The advertised model ID was saved. Its immutable backend revision was not independently verified.

Every task turn required at least one successful Python or Rust cell. Cells performed file reads, calculation, edits, and writes. All generated sources and library edits were inspected. They did not delegate the work to shell or subprocess calls. Common Node and Cargo checks ran after agent completion and were timed separately. This is a controlled cell test, with different rules from a product loop that permits native commands.

### Raw agent time

Values are seconds. They include workspace initialization, model requests, tool work, and repairs. They exclude daemon startup and the final external checker. Each value is one observation.

![Opus task time and compiler commands](assets/rust-cell-report-2026-10-08/paid-agent-all.svg)

{{paid_raw}}

### All Cargo and AOT costs shown separately

The table uses the same **agent interval**, in seconds. Cargo includes all managed Cargo commands in that interval: initialization, library gates, and failed retries. A `cargo test` command includes test execution. It is not pure compiler CPU time. AOT is the WasmEdge compiler command's wall time. Overlapping commands count once, and their intervals are clipped to the agent interval. Later checker commands are not subtracted from agent time.

{{paid_compilation}}

All Python agent intervals have zero Cargo/AOT deductions. Their adjusted values equal the raw values above. E08 checker Cargo appears only in the interval that includes validation. The dashboard lets readers select all Cargo or all Cargo plus AOT, and agent, user, or validation time. This is an arithmetic breakdown of recorded execution. No compile-free rerun took place.

In E09 AOT, three regex-related AOT commands took **29.31 seconds**. Raw agent time was 59.57 seconds. After all Cargo and AOT deductions, the remainder was about 25.14 seconds, versus 30.46 seconds for interpreter mode. Sources and cell counts differed. These adjusted task values are not a pure runtime speed ratio.

### Cell execution and repairs

{{paid_cells}}

The count column shows successful cells, runtime failures, and Cargo failures. All AOT compiler failure counts were zero. The {{cell_calls}} calls included {{runtime_failures}} runtime errors and {{cargo_failures}} Cargo errors. Each error was repaired within a successful task. All costs remain in the results.

In E09, Prime TS, Prime Rust, interpreter, and AOT used 11, 5, 5, and 3 cells. Python retained imports and caches. Rust used new processes. The saved runs show reusable helpers in use. They do not measure long-term token or money savings across tasks.

### Model requests and tokens

These totals cover all requests in the four tasks, including repairs and later turns. Prompt tokens include cached tokens. The cached column is a subset and must not be added again. These are task-trajectory measures.

{{usage}}

AOT used two fewer requests and 578 fewer output tokens than interpreter in this test. Generated code and repair paths differed. The result does not prove that AOT reduces model tokens. Rust output usage was not consistently below both Python variants. Complete billing records were unavailable, so token counts were not converted into actual charges.

## 7. Why Rust cells were slower

| Mechanism | Evidence | Status |
|---|---|---|
| Cargo during session initialization | Earlier provisioner tests: 0.35–0.39 s without a skill; 4.61–5.05 s with websearch, mainly its probe build | The all-Cargo ledger now captures this cost. The initialization work still exists. |
| New WasmEdge process per cell | Near-empty diagnostics and the latest R01 successful-cell average of about 8 ms | AOT still starts a process and VM. An embedded or reusable runner is not implemented. |
| Interpreted JSON and regex | Same-artifact AOT control and the latest data-join comparison | Trusted host AOT is available. Its compilation cost is separate. Interpreter remains available. |
| Fixed 5 ms bridge polling | Alternating tests and lower guest wait times | Normal WASI reply reads now wait for readiness and deadline. |
| Rebuild data and regex per cell | E09 sources and body timers. State uses files, without the host bridge. | Saved state can store processed results. A resident data service and cross-cell compiled-regex cache are not implemented. |
| Model output and repairs | Earlier E11 used more Rust output tokens. Latest E08 had compile errors; E09 cell counts differed. | These are task costs. Keep model requests, diagnostics, and failed attempts in the report. They cannot all be attributed to Wasm. |

## 8. Timing definitions

| Question | Measured boundary | Meaning and limits |
|---|---|---|
| How long to write code? | `llm.tool_arguments_generation`, `llm.code_emission`, `llm.code_ready`, saved SSE and cell sources | Client-visible source-argument windows. They do not isolate server generation or model thinking. |
| How long to prepare source and mounts? | `cell.source_prepare`, runner `prepareMs` | Source, mount, and state preparation. Write syscalls are not isolated. |
| How long to initialize? | `host.daemon_startup`, `cell.provision`, interval boundaries, all-Cargo ledger | Keep this in actual user time. Do not add nested Cargo again. |
| Rust → Wasm | `cargo.command`, `cell.compile`, `cargoMs` | Commands include IDs, arguments, cwd, timestamps, outcomes, and clock calibration. Typecheck, codegen, and linking are not fully separated. |
| Wasm → AOT | `aot.command`, `cell.aot_compile`, `aotCompileMs` | The command and its outer preparation/verification phase overlap. Do not add them. The outer phase also includes wrapper startup and other host work. |
| Runtime execution | Python `cell.python_execute`; Rust `cell.execution` | Rust includes launch, load, VM, guest, bridge, and I/O. Paid cells lack a complete guest-body breakdown. |
| Cleanup and persistence | `cell.bridge_cleanup`, `cell.snapshot`, `cell.other` | Successful snapshots and failed attempts remain recorded. Git failure does not rerun a successful cell. |
| Whole task | `task.agent_elapsed`, `run.user_elapsed`, `run.validated_elapsed`, `task.check` | Agent excludes daemon and checker. User includes daemon through agent completion. Validated includes initialization through checker completion. |
| Resource efficiency | Schema fields for CPU and peak tree RSS | This test lacks complete resource data. A memory cap does not prove memory or energy savings. |

Cell totals include successful and failed runtime execution. Compile failures have no runtime duration. The successful-cell average is computed within each run, then summarized across runs. Parallel cell totals measure work, not task wall time.

Labels have distinct meanings. **Complete measurement, deduction 0** means a complete ledger confirms no compiler command in that interval. **No AOT phase** means the phase is not applicable. **Cannot calculate** means data are insufficient. **Excluded from comparison** means output checks or cell rules failed. Missing values are not replaced with zero. Python 0 ms means below reporting resolution.

## 9. Environment and test history

The host was Darwin 25.6.0 arm64, Apple M5 Max, 18 logical CPUs, and 128 GiB RAM. Tools were Node 24.13.1, Cargo/rustc 1.98.1, and WasmEdge 0.14.1. Rust host, adapter, and guest builds used release mode.

The latest fork used baseline `48d6312570f7d39809703db2c69a43f342fb7424` plus a saved uncommitted runtime patch. The commit alone cannot reproduce it. Prepared inputs, launchers, templates, collectors, hashes, and original outputs are saved.

{{history}}

Host replay, native-tool observation, cell-only tests, all-Cargo capture, and AOT tests have different controls. They are not pooled. Early bridge and native-command adapter failures remain saved. The latest fixed matrix covers six cases, not all 16 designed runtime cases.

The [August feasibility study](../REPORT.en.md), [August 12-task benchmark](benchmark-comparison-2026-08-10.en.md), and [October 7 microbenchmark](runtime-microbenchmark-2026-10-07.en.md) are historical context. Different models, runtimes, and environments prevent pooling them with this test.

The latest two campaigns contain {{spans}} spans, with no schema or integrity errors. Capture is complete for {{cargo_commands}} Cargo and {{aot_commands}} AOT commands. Paid responses, generated code, repairs, sessions, outputs, checkers, and failed attempts are saved. Earlier scans found no actual API key in the selected text artifacts. That is a scoped artifact check, not whole-system secret detection.

Fixed cases have n=3 per group. Paid tasks have n=1. No confidence intervals, cross-platform repetition, or complete instrumentation-overhead audit were produced. The results explain local workload costs and the tested changes. They do not estimate a stable cross-task win rate. An advertised model ID does not independently verify a backend revision.

## 10. Adoption and next work

Rust cells are useful when the product needs explicit guest permissions, controlled data access, reusable checked code, and inspectable saved state. AOT is a candidate for longer CPU, JSON, and regex work. Interpreter avoids the extra AOT compilation for short or frequently changed cells. Choose from actual workload costs.

Priorities are:

1. Measure trustworthy AOT artifact reuse. Keep source, import-policy, toolchain, and artifact verification in the cache key. Report compilation, hit rate, invalidation, and reuse count.
2. Evaluate an embedded runner or worker reuse to reduce process/VM startup. Preserve a fresh cell instance and the permission boundary.
3. Measure helper and state reuse over long sessions. Separate memory reuse, file loading, reparsing, and regex construction.
4. Run more tasks and paired repetitions. Complete the instrumentation-overhead audit and report confidence intervals before a general speed verdict.
5. Repeat relevant safety tests on Linux with the optional compiler and process-tree controls enabled. Measure CPU and memory use separately from configured limits.

## 11. Reports and evidence

- [Latest four-way fixed-program dashboard](../poc/bench/results/four-way-aot-bridge-runtime-01/report.en.html): filters, cell totals/averages, Cargo/AOT, phases, traces, and CSV/SVG export.
- [Latest four-way Opus 5.5 dashboard](../poc/bench/results/four-way-opus55-aot-bridge-01/report.en.html): 16 runs, model output, full tasks, repairs, and compiler views.
- [AOT and bridge implementation](benchmark-aot-bridge-2026-10-08.en.md) and [earlier runtime diagnosis](benchmark-cell-runtime-analysis-2026-10-08.en.md).
- [Benchmark protocol](benchmark-three-way-design-2026-10-08.en.md), [validation history](benchmark-three-way-validation-2026-10-08.en.md), [trace schema](benchmark-trace.schema.json), and [runner instructions](../poc/bench/three-way/README.en.md).
- [Raw safety-test results](../poc/bench/results/consolidated-report-20261008-01/security-validation.json) and [aggregate data and source hashes](assets/rust-cell-report-2026-10-08/data.json).
- [Runtime settings and trust boundary](../packages/coding-agent/docs/rlm-runtime.md), [English design decision guide](../DESIGN.en.md), and [official WasmEdge AOT guide](https://wasmedge.org/docs/start/build-and-run/aot/).

The HTML file embeds its text, tables, and charts and opens offline. Evidence links use repository-relative paths. The English share package preserves those paths for the included reports. Raw traces and generated code remain in their original language.

Rebuild the English set with `uv run --with markdown==3.10.2 python poc/bench/english-report.py`. It reads saved results, validates links and data preservation, and makes no model calls. The [Chinese report](rust-cell-report-2026-10-08.html) remains available separately.
