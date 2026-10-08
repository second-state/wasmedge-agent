# Rust Cells: Safety and Performance Report

Date: October 8, 2026. This report compares Prime Agent with a TypeScript host and Python cells, Prime Agent with a Rust host and Python cells, and wasmedge-agent with Rust cells in WasmEdge interpreter and AOT modes. It separates the latest four-way tests from earlier diagnostic tests.

**Share this HTML file.** Text, charts, key tables, and timing definitions are included. It opens offline and needs no other files. Optional source citations use the web.

<a id="conclusions"></a>

## Conclusions first

| Question | Finding | What it means |
|---|---|---|
| Why use Rust cells? | Compile checks, explicit guest permissions, saved source and state | The main value is controlled, inspectable execution. Host and compiler permissions still need separate controls. |
| Does AOT help? | Data join: 293.578 → 21.266 ms; **92.8% less execution time** | AOT helps this fixed workload. Its compilation cost is separate and remains in full task time. |
| Does the bridge update help? | 100 echoes: 652.714 → 65.795 ms; **89.9% less process time** | Readiness removes polling waits. AOT reduces this further to 11.224 ms. |
| Is Rust faster than Python here? | All six measured Rust/AOT cell totals remain above both resident Python kernels | Short cells still pay for a new process and VM. There is no general Rust speed win in this matrix. |
| Can we trust the scope? | **72/72 fixed runs; 16/16 tasks; 65 safety tests passed** | Fixed n=3; tasks n=1; 14 Linux tests skipped. These are local results, not a broad performance ranking. |

<a id="runtime"></a>

## 1. Fixed-program execution

The latest test has 6 cases × 4 variants × 3 repetitions. Both Wasm modes use identical Rust reference source. Python performs equivalent operations under the same output contract. This removes model-generation variance. It still includes differences between languages and libraries.

Values below are the median of three per-run cell execution totals, in milliseconds. **They exclude Cargo, AOT compilation, initialization, and snapshots.** Rust execution includes the new process, module load, VM, guest, bridge, and output drain. Python uses an existing kernel. A reported 0 ms is below its integer-millisecond resolution. R01 and R04 each have two cells.

![Four-way fixed-program cell execution](assets/rust-cell-report-2026-10-08/runtime-linear.svg)

| Case | Prime TS / Python | Prime Rust / Python | Rust / interpreter | Rust / AOT |
| --- | --- | --- | --- | --- |
| R01-noop | 1.000 | 0.000 | 18.162 | 15.922 |
| R03-cpu | 5.000 | 5.000 | 10.306 | 8.224 |
| R04-data-join | 8.000 | 6.000 | 293.578 | 21.266 |
| R05-repository-scan | 3.000 | 2.000 | 37.079 | 11.805 |
| R09-bridge | 8.000 | 6.000 | 64.415 | 15.182 |
| R12-error-repair | 1.000 | 0.000 | 9.120 | 8.154 |

Data join fell from 293.578 ms in interpreter mode to 21.266 ms in AOT mode, a 92.8% reduction. Repository scan and bridge execution also improved. The short CPU case still took 8.224 ms in AOT, versus 5.000 ms in each Python kernel. A new process and VM impose a fixed cost on every Rust cell. The results support choosing a mode for the workload.

Earlier diagnostics confirmed that Python JSON uses the `_json` C accelerator. Rust `serde_json` runs as interpreted Wasm in interpreter mode. A near-empty process took about 8–10 ms. Guest work can be short while cell time remains limited by launch and load costs. The earlier runtime analysis contains CPU, JSON, regex, and state body timers. Its AOT and 1 ms polling tests were diagnostic controls before the product update. The implemented AOT path and readiness update are described below.

<a id="bridge"></a>

## 2. Controlled bridge comparison

The test used identical `diff.rs` and `bridge.rs` source bytes, the same handlers, and a 1 KiB payload. It alternated old polling, readiness-based interpreter, and readiness-based AOT execution. Each mode and case had two warmups and 15 measured samples. All 102 samples were saved. The chart and table use only measured-sample medians.

![Alternating bridge comparison](assets/rust-cell-report-2026-10-08/bridge.svg)

| Work | Old polling (ms) | Readiness interpreter ms | Readiness AOT ms |
| --- | --- | --- | --- |
| One diff / ack | 23.041 | 11.030 | 8.106 |
| 100 echo × 1 KiB | 652.714 | 65.795 | 11.224 |

For 100 echoes, process wall time fell from 652.714 ms to 65.795 ms after the readiness update, a 89.9% reduction. Normal WASI reply reads now use `poll_oneoff` to wait for stdin readiness or a monotonic deadline. They wake when data arrives. Native TCP and rare write retries keep their existing polling.

AOT reduced the total further to 11.224 ms. Guest-body medians are shown below; they exclude process launch and module/VM setup. After removing polling waits, interpreter execution and JSON framing still have measurable costs. We do not pool these results with earlier bridge tests under different scheduling conditions.

AOT compilation took another 2.74/2.76 seconds before execution. If a future trusted artifact cache allowed reuse, this fixed 100-echo workload would need about **51 executions** to recover one 2.76-second compile cost at a saving of about 54.57 ms per execution. This is an arithmetic estimate under a reuse assumption. The current product recompiles every cell and does not receive this benefit.

### Guest-body timing

| Work | Old polling body ms | Readiness interpreter body ms | Readiness AOT body ms |
| --- | --- | --- | --- |
| One diff / ack | 12.211 | 0.410 | 0.160 |
| 100 echo × 1 KiB | 639.344 | 53.548 | 3.207 |

These are the same alternating control samples as the process table. Body and process medians describe different boundaries; do not subtract them to reconstruct individual phases.

<a id="aot-details"></a>

### Implemented AOT path

`rustCell.runtimeMode` defaults to `interpreter`; `aot` adds a fourth comparison group. AOT checks imports, strips all guest custom sections, and compiles on the host with `--interruptible` and gas instrumentation when configured. The core Wasm must match the inspected input and a native payload must be present. Verification failure stops execution, without a silent interpreter fallback. Each cell compiles again; there is no AOT cache. Skill/library tests still use interpreter mode.

Stripped input, AOT output, and SHA-256 provenance stay in host-only `.aot/`, outside guest mounts. Compilation and execution share timeout, cancellation, and process-limit settings. The pinned WasmEdge 0.14.1 CLI loads AOT automatically; saved command records identify the flags. No newer run-mode flag was used.

`aot.command` measures compiler spawn-to-close time and excludes the Node wrapper's own startup. `cell.aot_compile` also includes stripping, verification, and provenance. It does not overlap runner `cell.execution`. All-Cargo capture includes initialization, cells, library gates, retries, and checkers; deductions are clipped to the selected task interval and count overlapping commands once.

<a id="tasks"></a>

## 3. Opus 5.5 task results

The test has 4 tasks × 4 variants × 1 repetition. All 16 runs passed the common checker and per-turn cell rules. There were 70 paid model requests. The route was `anthropic/claude-opus-5-5`, with reasoning off. The advertised model ID was saved. Its immutable backend revision was not independently verified.

Every task turn required at least one successful Python or Rust cell. Cells performed file reads, calculation, edits, and writes. All generated sources and library edits were inspected. They did not delegate the work to shell or subprocess calls. Common Node and Cargo checks ran after agent completion and were timed separately. This is a controlled cell test, with different rules from a product loop that permits native commands.

### Raw agent time

Values are seconds. They include workspace initialization, model requests, tool work, and repairs. They exclude daemon startup and the final external checker. Each value is one observation.

![Opus task time and compiler commands](assets/rust-cell-report-2026-10-08/paid-agent-all.svg)

| Task | Prime TS / Python | Prime Rust / Python | Rust / interpreter | Rust / AOT |
| --- | --- | --- | --- | --- |
| E-03-fix-bug | 8.227 | 7.370 | 14.517 | 19.481 |
| E-08-rust-rename | 6.834 | 5.897 | 16.565 | 21.003 |
| E-09-helper-accumulation | 49.535 | 23.817 | 35.342 | 59.570 |
| E-11-join-report | 9.678 | 8.556 | 19.391 | 23.400 |

### All Cargo and AOT costs shown separately

The table uses the same **agent interval**, in seconds. Cargo includes all managed Cargo commands in that interval: initialization, library gates, and failed retries. A `cargo test` command includes test execution. It is not pure compiler CPU time. AOT is the WasmEdge compiler command's wall time. Overlapping commands count once, and their intervals are clipped to the agent interval. Later checker commands are not subtracted from agent time.

| Task | Rust runtime | Raw agent | All Cargo | AOT | After Cargo + AOT |
| --- | --- | --- | --- | --- | --- |
| E-03-fix-bug | Rust / interpreter | 14.517 | 4.486 | 0.000 | 10.031 |
| E-03-fix-bug | Rust / AOT | 19.481 | 4.226 | 4.277 | 10.979 |
| E-08-rust-rename | Rust / interpreter | 16.565 | 4.056 | 0.000 | 12.510 |
| E-08-rust-rename | Rust / AOT | 21.003 | 4.630 | 1.675 | 14.697 |
| E-09-helper-accumulation | Rust / interpreter | 35.342 | 4.882 | 0.000 | 30.460 |
| E-09-helper-accumulation | Rust / AOT | 59.570 | 5.122 | 29.310 | 25.138 |
| E-11-join-report | Rust / interpreter | 19.391 | 5.673 | 0.000 | 13.718 |
| E-11-join-report | Rust / AOT | 23.400 | 5.075 | 4.488 | 13.837 |

All Python agent intervals have zero Cargo/AOT deductions. Their adjusted values equal the raw values above. E08 checker Cargo appears only in the interval that includes validation. The chart above lets readers select all Cargo or all Cargo plus AOT, and agent, user, or validation time. This is an arithmetic breakdown of recorded execution. No compile-free rerun took place.

In E09 AOT, three regex-related AOT commands took **29.31 seconds**. Raw agent time was 59.57 seconds. After all Cargo and AOT deductions, the remainder was about 25.14 seconds, versus 30.46 seconds for interpreter mode. Sources and cell counts differed. These adjusted task values are not a pure runtime speed ratio.

### Cell execution and repairs

<!-- paid-cell-chart -->

| Task | Variant | Success / Runtime failures / Cargo failures | Cell execution total (ms) |
| --- | --- | --- | --- |
| E-03-fix-bug | Prime TS / Python | 2/0/0 | 4.000 |
| E-03-fix-bug | Prime Rust / Python | 2/0/0 | 1.000 |
| E-03-fix-bug | Rust / interpreter | 2/0/0 | 21.529 |
| E-03-fix-bug | Rust / AOT | 2/0/0 | 17.443 |
| E-08-rust-rename | Prime TS / Python | 1/0/0 | 3.000 |
| E-08-rust-rename | Prime Rust / Python | 1/0/0 | 2.000 |
| E-08-rust-rename | Rust / interpreter | 1/0/1 | 10.758 |
| E-08-rust-rename | Rust / AOT | 1/0/1 | 9.421 |
| E-09-helper-accumulation | Prime TS / Python | 6/5/0 | 24.000 |
| E-09-helper-accumulation | Prime Rust / Python | 4/1/0 | 3.000 |
| E-09-helper-accumulation | Rust / interpreter | 4/0/1 | 83.375 |
| E-09-helper-accumulation | Rust / AOT | 3/0/0 | 33.263 |
| E-11-join-report | Prime TS / Python | 2/0/0 | 5.000 |
| E-11-join-report | Prime Rust / Python | 2/0/0 | 3.000 |
| E-11-join-report | Rust / interpreter | 2/0/0 | 22.356 |
| E-11-join-report | Rust / AOT | 2/0/0 | 18.846 |

The count column shows successful cells, runtime failures, and Cargo failures. All AOT compiler failure counts were zero. The 46 calls included 6 runtime errors and 3 Cargo errors. Each error was repaired within a successful task. All costs remain in the results.

In E09, Prime TS, Prime Rust, interpreter, and AOT used 11, 5, 5, and 3 cells. Python retained imports and caches. Rust used new processes. The saved runs show reusable helpers in use. They do not measure long-term token or money savings across tasks.

### Model requests and tokens

These totals cover all requests in the four tasks, including repairs and later turns. Prompt tokens include cached tokens. The cached column is a subset and must not be added again. These are task-trajectory measures.

| Variant | Requests | Prompt tokens | Cached subset | Output tokens |
| --- | --- | --- | --- | --- |
| Prime TS / Python | 22 | 309,260 | 237,307 | 4,327 |
| Prime Rust / Python | 16 | 264,457 | 194,803 | 2,709 |
| Rust / interpreter | 17 | 177,375 | 134,027 | 4,190 |
| Rust / AOT | 15 | 151,682 | 108,740 | 3,612 |

AOT used two fewer requests and 578 fewer output tokens than interpreter in this test. Generated code and repair paths differed. The result does not prove that AOT reduces model tokens. Rust output usage was not consistently below both Python variants. Complete billing records were unavailable, so token counts were not converted into actual charges.

<a id="value"></a>

## 4. Value and evidence

| Value | Supported claim | Evidence and limits |
|---|---|---|
| Limit generated code | The guest can use only allowed WASI imports and explicit directory mounts. Direct socket imports are rejected before execution. | Real WasmEdge tests reject `sock_open` in both modes. Host handlers have separate permissions. |
| Reduce credential exposure | The guest receives only selected environment variables. Cargo and the AOT compiler use an environment allowlist. | Environment and compiler tests. Without the Cargo sandbox, the compiler can still read host files and Cargo configuration. |
| Bound guest execution | The runner can limit gas, linear memory pages, and cell time. Invalid settings fail closed. | Gas and memory-growth tests in both modes. Gas and page caps require configuration. They do not cap total process-tree RSS. |
| Find errors before execution | Rust checks types, borrowing, and ownership before running the guest. A failed build does not run the new cell. | Compiler diagnostics, source restoration, and saved repair attempts. A successful build does not prove correct task logic. Repairs can add model calls. |
| Save reusable code | Helpers remain as `agent_lib` source. State is saved explicitly. Successful cells attempt workspace Git snapshots. | Workspace, library-gate, and snapshot implementation. No persistent object namespace, atomic rollback of external effects, or bit-for-bit replay guarantee. |
| Reduce selected execution costs | AOT reduces interpreter costs for JSON and regex work. Readiness-based bridge reads reduce polling delays. | Fixed-program comparisons and alternating bridge tests. Cargo, AOT, and new-process costs remain separate. |

The supported product claim is: **Rust cells are inspectable execution units with explicit guest permissions and saved code and data. WasmEdge AOT provides a way to reduce compute-heavy execution costs. The bridge update has reduced request/reply delays.** These tests do not show that all Rust tasks are faster, use less memory, or cost less in model fees than Python tasks.

<a id="safety"></a>

## 5. Safety controls

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

| Test file | Passed | Platform skips |
| --- | --- | --- |
| rust-cell-aot.test.ts | 5 | 0 |
| rust-cell-bridge-integration.test.ts | 4 | 0 |
| rust-cell-cargo-environment.test.ts | 2 | 0 |
| rust-cell-cargo-sandbox.test.ts | 3 | 7 |
| rust-cell-harness-mounts.test.ts | 4 | 0 |
| rust-cell-process-limits.test.ts | 3 | 7 |
| rust-cell-resource-limits.test.ts | 11 | 0 |
| rust-cell-wasm-imports.test.ts | 16 | 0 |
| rust-cell-workspace-policy.test.ts | 17 | 0 |
| Total | 65 | 14 |

On macOS, real WasmEdge tests passed for socket-import rejection, gas exhaustion, memory growth limits, large UTF-8 bridge messages, and a fresh handshake after timeout in both modes. The read-only project test used interpreter mode. Unit tests also cover environment rules, import rules, mount aliases, AOT stripping, provenance, and failure handling.

Real Linux Bubblewrap and cgroup tests were skipped because the platform requirements were absent. The macOS results do not prove Linux enforcement. See the runtime trust boundary for full settings and excluded host paths.

<a id="architecture"></a>

## 6. Four architectures

| Variant | Host | Cell / runtime | Pinned revision |
| --- | --- | --- | --- |
| Prime TS / Python | TypeScript | Python resident kernel | `7d442aafa985` |
| Prime Rust / Python | Rust | Python resident kernel | `967eb13fd488` |
| Rust / interpreter | TypeScript | Rust / WasmEdge interpreter | `48d6312570f7` + runtime patch |
| Rust / AOT | TypeScript | Rust / WasmEdge AOT | `48d6312570f7` + runtime patch |

The Prime Rust port changes the host language. It still runs Python cells. wasmedge-agent still has a TypeScript host. The main runtime comparison is a persistent Python kernel versus Rust/Wasm cells. The latest interpreter and AOT groups use the same fork build and updated bridge. Only the runtime mode differs.

Python reuses its kernel and in-memory objects. Each Rust cell is a complete program in a new WasmEdge process and VM. Helpers, state, and project files persist on disk. This makes saved content explicit. It can also require each cell to reload data or rebuild JSON and regex structures.

![Guest permissions and trust boundary](assets/rust-cell-report-2026-10-08/boundary.svg)

<a id="diagnosis"></a>

## 7. Why Rust cells were slower

| Mechanism | Evidence | Status |
|---|---|---|
| Cargo during session initialization | Earlier provisioner tests: 0.35–0.39 s without a skill; 4.61–5.05 s with websearch, mainly its probe build | The all-Cargo ledger now captures this cost. The initialization work still exists. |
| New WasmEdge process per cell | Near-empty diagnostics and the latest R01 successful-cell average of about 8 ms | AOT still starts a process and VM. An embedded or reusable runner is not implemented. |
| Interpreted JSON and regex | Same-artifact AOT control and the latest data-join comparison | Trusted host AOT is available. Its compilation cost is separate. Interpreter remains available. |
| Fixed 5 ms bridge polling | Alternating tests and lower guest wait times | Normal WASI reply reads now wait for readiness and deadline. |
| Rebuild data and regex per cell | E09 sources and body timers. State uses files, without the host bridge. | Saved state can store processed results. A resident data service and cross-cell compiled-regex cache are not implemented. |
| Model output and repairs | Earlier E11 used more Rust output tokens. Latest E08 had compile errors; E09 cell counts differed. | These are task costs. Keep model requests, diagnostics, and failed attempts in the report. They cannot all be attributed to Wasm. |

### Earlier controls: guest work versus cell time

These controls predate the readiness update. Each runtime median uses 15 measured samples after two warmups. Interpreter and AOT execute the same artifact. Body timers run inside the guest; they exclude launch/load time. Do not pool these values with the latest six-case matrix.

| Fixed work | Interpreter cell ms | AOT cell ms | Interpreter body ms | AOT body ms |
|---|---|---|---|---|
| Near-empty program | 8.361 | 7.026 | Not instrumented | Not instrumented |
| 100,000 CPU operations | 10.690 | 6.616 | 2.022 | 0.023 |
| 10,000-record JSON parse | 223.773 | 9.009 | 211.703 | 1.220 |
| Regex and saved state | 31.237 | 10.308 | Regex 4.574; match 3.484 | Regex 0.161; match 0.048 |

The related AOT compiler commands took 1.407, 1.505, 1.822, and 10.810 seconds. These costs are excluded from the cell columns above. Fast guest work does not remove process/VM overhead. Python JSON uses its native `_json` accelerator; Rust JSON runs as Wasm. These paths do not have the same library implementation.

<a id="timing"></a>

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

<a id="method"></a>

## 9. Environment and test history

The host was Darwin 25.6.0 arm64, Apple M5 Max, 18 logical CPUs, and 128 GiB RAM. Tools were Node 24.13.1, Cargo/rustc 1.98.1, and WasmEdge 0.14.1. Rust host, adapter, and guest builds used release mode.

The latest fork used baseline `48d6312570f7d39809703db2c69a43f342fb7424` plus a saved uncommitted runtime patch. The commit alone cannot reproduce it. Prepared inputs, launchers, templates, collectors, hashes, and original outputs are saved.

Earlier campaigns used host replay, native tools, or different Cargo capture rules. They are retained locally for diagnosis and are excluded from the latest comparison.

Host replay, native-tool observation, cell-only tests, all-Cargo capture, and AOT tests have different controls. They are not pooled. Early bridge and native-command adapter failures remain saved. The latest fixed matrix covers six cases, not all 16 designed runtime cases.

The August feasibility study, August 12-task benchmark, and October 7 microbenchmark are historical context. Different models, runtimes, and environments prevent pooling them with this test.

The latest two campaigns contain 5422 spans, with no schema or integrity errors. Capture is complete for 86 Cargo and 32 AOT commands. Paid responses, generated code, repairs, sessions, outputs, checkers, and failed attempts are saved. Earlier scans found no actual API key in the selected text artifacts. That is a scoped artifact check, not whole-system secret detection.

Fixed cases have n=3 per group. Paid tasks have n=1. No confidence intervals, cross-platform repetition, or complete instrumentation-overhead audit were produced. The results explain local workload costs and the tested changes. They do not estimate a stable cross-task win rate. An advertised model ID does not independently verify a backend revision.

<a id="aot-validation"></a>

### Recorded AOT implementation checks

At implementation time, root checks and the full workspace build passed. Real interpreter/AOT integration passed 15 tests for large UTF-8 bridge messages, forbidden socket imports, fresh handshake after timeout, gas exhaustion, and memory-growth caps. Native bridge release tests passed 12/12; other related suites passed 86 tests with three environment-specific skips. These are earlier implementation checks, separate from the 65-pass/14-skip safety recheck above. Their counts must not be added together. No runtime tests were rerun to edit this report.

| Latest campaign | Schema-valid spans | Captured Cargo commands | Captured AOT commands |
|---|---|---|---|
| Fixed-program: 72 runs | 3,822 | 54 | 24 |
| Opus tasks: 16 runs | 1,600 | 32 | 8 |

Both Cargo-only and Cargo-plus-AOT deductions are available for all 88 runs. Paid sources and library edits were inspected for shell/subprocess delegation. All repair costs remain recorded; all AOT compiler failure counts were zero. Wrappers and small sample counts still limit performance claims.

<a id="next"></a>

## 10. Adoption and next work

Rust cells are useful when the product needs explicit guest permissions, controlled data access, reusable checked code, and inspectable saved state. AOT is a candidate for longer CPU, JSON, and regex work. Interpreter avoids the extra AOT compilation for short or frequently changed cells. Choose from actual workload costs.

Priorities are:

1. Measure trustworthy AOT artifact reuse. Keep source, import-policy, toolchain, and artifact verification in the cache key. Report compilation, hit rate, invalidation, and reuse count.
2. Evaluate an embedded runner or worker reuse to reduce process/VM startup. Preserve a fresh cell instance and the permission boundary.
3. Measure helper and state reuse over long sessions. Separate memory reuse, file loading, reparsing, and regex construction.
4. Run more tasks and paired repetitions. Complete the instrumentation-overhead audit and report confidence intervals before a general speed verdict.
5. Repeat relevant safety tests on Linux with the optional compiler and process-tree controls enabled. Measure CPU and memory use separately from configured limits.

<a id="sources"></a>

## Source records and reproducibility

All decision data are included above: the six-case runtime matrix, bridge controls, full task time, all Cargo and AOT deductions, cell failures, model usage, safety tests, and timing definitions. Raw traces, generated programs, and historical dashboards remain local; reading this report does not require them.

The report uses saved aggregates and source SHA-256 records. These identify the retained evidence; hashes alone are not a reproduction package. The baseline plus runtime patch is required to reproduce the experiment. Rebuilding this reader does not rerun benchmarks or call a model.

`uv run --with markdown==3.10.2 python poc/bench/consolidated-report.py` rebuilds both standalone readers from tracked aggregate data, templates, and SVGs. Add `--refresh-evidence` with Matplotlib 3.10.8 only when the original local evidence is available. This option audits saved data; it does not make model requests.

<details><summary>Saved evidence: source SHA-256 records</summary><div class="table-scroll"><table><thead><tr><th>Source</th><th>SHA-256</th></tr></thead><tbody><tr><td><code>packages/coding-agent/test/rust-cell-aot.test.ts</code></td><td><code>8290ed6c37aa7a469d3932a6b402fe07bd86a97f40031b5b470a0c04fea4d670</code></td></tr><tr><td><code>packages/coding-agent/test/rust-cell-bridge-integration.test.ts</code></td><td><code>b45b39be3b57b264739e3041afc392b45fc398b7eb5e2dee3a0d8b1c88e80528</code></td></tr><tr><td><code>packages/coding-agent/test/rust-cell-cargo-environment.test.ts</code></td><td><code>73d41dcab73b2894a2b19ebe7c2156f4a9e014aaeba39a4bbf33b9408c0362ec</code></td></tr><tr><td><code>packages/coding-agent/test/rust-cell-cargo-sandbox.test.ts</code></td><td><code>387e492f23025fc3c4cc932fd6b3557016fd9c4c0c9cb53f1509e7a177ba5679</code></td></tr><tr><td><code>packages/coding-agent/test/rust-cell-harness-mounts.test.ts</code></td><td><code>226f528a773a0878c784e3d11d88bee8240ad521a36c55f7b7c0efecc40e93fd</code></td></tr><tr><td><code>packages/coding-agent/test/rust-cell-process-limits.test.ts</code></td><td><code>357d8ae9ce59237e38dd5698c90c66c8b94e3fdd64dbb64d98e8a3fe488abbea</code></td></tr><tr><td><code>packages/coding-agent/test/rust-cell-resource-limits.test.ts</code></td><td><code>07abf0ea1fe25f528be78eac78de227aac27ca67fd0d88de83d67ce3d3dd7154</code></td></tr><tr><td><code>packages/coding-agent/test/rust-cell-wasm-imports.test.ts</code></td><td><code>ac2828b2e25ace4ee2e20d02815cc26b3f8ec06d1cfe30c348d62f4c0cffa2dd</code></td></tr><tr><td><code>packages/coding-agent/test/rust-cell-workspace-policy.test.ts</code></td><td><code>172670770d05257739d21a0f50510f2ea9b25e7ca0f9f2a983784c0b9d5c21c7</code></td></tr><tr><td><code>poc/bench/consolidated-report.py</code></td><td><code>c30ba67d887eb59f0b6bf6aad8606f4a33624cea1fdb8e892f2fe2fc94a36ff8</code></td></tr><tr><td><code>poc/bench/results/bridge-readiness-diagnostic-20261008-01/summary.json</code></td><td><code>50f6cb67cd43c026f7a316b4ee038d0132d19b7d022d9863b5206e726d49cca9</code></td></tr><tr><td><code>poc/bench/results/consolidated-report-20261008-01/security-validation.json</code></td><td><code>a37a81c693af3197dfdc40f93374cad6d0160ff210c9d4673a9ac8df485b3a89</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/report-provenance.json</code></td><td><code>ec552643f5c9f7807810dd78d87151e77b9594b32ec33dc7a27b2cbd9935694d</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/report.html</code></td><td><code>527c9a20c2ea25277defc263789ebcccfe9362a830f1d54814f7b64b901f211b</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/report.json</code></td><td><code>2b16c3fab6b481c432246d890be7ad77a8011d02235b03ec8496046ef7d32288</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-prime-rust-r1-5612fe53-8783-4fcd-bcc7-4b851de6b9c0/spans.jsonl</code></td><td><code>408106eba82f27463ec01c122f95f2869b873f427ab14b373cd7f6d85d28bfbd</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-prime-rust-r2-2dbbf5cf-001e-4ea2-b206-6ce91ff65ffc/spans.jsonl</code></td><td><code>2a2f29e692d4178e7d43bbefdd6e147bbf5b85bb901b673421dddd1fddeda102</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-prime-rust-r3-f3e0774d-a136-4e2d-b8fb-7b4efc9da9df/spans.jsonl</code></td><td><code>0d7a9966752d4cb0fcc41a2d927a6470e6750b4bb465c6d1320109db5459f391</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-prime-ts-r1-d9cb3d80-3e99-490f-b46b-5520dbfb5349/spans.jsonl</code></td><td><code>e6e40104c46950df29859b10921c655a77b96e0f0736a6b592534407ad4ddf3d</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-prime-ts-r2-c522bc92-8191-4dd7-8266-6309eb671989/spans.jsonl</code></td><td><code>e85f026a037bb3466e5bbe36c0a554824ffc2f9c0be382935daafa2caf3a31d6</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-prime-ts-r3-1aa142d5-cb5f-4858-9a76-34f2f8ad9eb3/spans.jsonl</code></td><td><code>8c0c8f4a44f7c74d4c7c9a18a4f36a05791c05d4f920515fad0f86514c3b9851</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-wasmedge-aot-r1-5c32ff37-566d-4122-b67a-33210027d95d/spans.jsonl</code></td><td><code>d4356f33287ce012b1fdebe70a788ccbd106ed2bdc746d50abaeb91ab596ded4</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-wasmedge-aot-r2-5d83cbb3-c83e-447d-bf2e-47cc4725b929/spans.jsonl</code></td><td><code>b3e88e37d30d20a2c3b8221a6ee44555cc2f84e6f71a80a7f9213d78b7eeedc7</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-wasmedge-aot-r3-ced08808-3d48-4a1b-bdb2-0b4154a33754/spans.jsonl</code></td><td><code>4cf2e2a3123b00213ef8fc9262c2a1c804ae02e3e2072d3df7eb95627545593e</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-wasmedge-r1-087e2edc-d58e-49a8-92cd-9b2f50114a82/spans.jsonl</code></td><td><code>6fb6c24e48aae8ad1ae265bfbd630c36284ef6b4183e36ba4ff3e0313196ff6c</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-wasmedge-r2-0b53fd4f-e8ab-44ca-82ea-3d2629d1e9aa/spans.jsonl</code></td><td><code>f7814ecb39629808232ccf48a78f6e0109723c8614a83b5a8cba0def58452522</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R01-noop-wasmedge-r3-52b3d206-8acd-4fd3-addc-45848152ffde/spans.jsonl</code></td><td><code>1081af3d936a1dc9490bcda8e5409b2c4e65bea413ba976f3f500450d54c194d</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-prime-rust-r1-82c883f2-649d-4048-821a-bf11e906f623/spans.jsonl</code></td><td><code>35154b02264ffb04887bd00ff4f2cae1df9104d27b3509deef670f2c5d714724</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-prime-rust-r2-15d1a4b5-2b8b-43ca-9bf3-884cb1fdaf03/spans.jsonl</code></td><td><code>ac9ddb9825a0c92352aca9e3edb7518612e2df59aae1a056281473259749b31a</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-prime-rust-r3-915c300d-374e-48ba-afdc-1915e9305a42/spans.jsonl</code></td><td><code>7bf8e33ea4f20b1f525225dd04a1c00070cb0c676f7214f7f468b44e5c77373f</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-prime-ts-r1-388f0331-5d49-4c30-9b9c-d3292b085ae4/spans.jsonl</code></td><td><code>fad427e5e3a2b4b1a4f334e2eb2f1ed01cc5611313580df2869233035d423b6a</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-prime-ts-r2-bc77c63a-a09d-40a2-a9dc-eeced098ddd9/spans.jsonl</code></td><td><code>45b9b7a745d0d8cda59f8f3d81c6d7d17e223eb9ef8bede6a0575ce31e2edb34</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-prime-ts-r3-4a91ead9-425b-48c6-9794-b5bc8de92820/spans.jsonl</code></td><td><code>8ab4902440a927d77c62aba3cd9e4183a100c9a30fd7a842c5a124d9eb82409b</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-wasmedge-aot-r1-23250666-eb90-4f75-81b1-7c04d5b9a97b/spans.jsonl</code></td><td><code>c410336d6e6894be596fc25ea5e666a9be904f92f47d11657778c12656032c00</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-wasmedge-aot-r2-a2804f65-59a6-45c3-94c8-e6e4db3ce508/spans.jsonl</code></td><td><code>d38c411a109a87e2ac47813e7726861e52e6674adf21f50a7bb2217bd2bf939a</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-wasmedge-aot-r3-8b16d77d-3069-4e0f-b1ec-322efa5e6e09/spans.jsonl</code></td><td><code>b0cfcc8e73bf7b2fbc0e5285ab3a798773f8c949b51ee039d814fc92ea02f9e2</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-wasmedge-r1-75851002-c2f3-4755-b0fb-db46d6556593/spans.jsonl</code></td><td><code>9ba1f91b323796f390aef58f35e91943a122ad896591b03f6cf566a0af9e47ce</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-wasmedge-r2-5cce0270-4e75-40eb-b98b-8a528844e31b/spans.jsonl</code></td><td><code>d52d04428000dab9e194efea0d743d2f80e418ec9a414cc79a76f53aa7d0ca99</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R03-cpu-wasmedge-r3-92256d12-64ff-4cd9-a427-5bc28595da98/spans.jsonl</code></td><td><code>3f8527d6228329b5d46fb43d02346ffb2023242d691c3ddc4994d60c3ffbdcab</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-prime-rust-r1-d14030a7-7d31-4154-882b-2ba21f7eabf9/spans.jsonl</code></td><td><code>9278215342ea89750f70f405a17e3d39feed57d80be21ef0fed70bb15dd9fb88</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-prime-rust-r2-d90bbacc-eeea-4fbd-a655-d57f0f7590de/spans.jsonl</code></td><td><code>914b00d63234d867bc74e8dd7582c327b1a1bf86199bb4e27db5df7520e3d433</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-prime-rust-r3-bf0848c3-97b7-4fd8-a8a1-4790dc2c05ce/spans.jsonl</code></td><td><code>82fd308ca6baf645d7ef0456c8ecc6c1d58edd1dab85d6e4808b8d1f47f2501d</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-prime-ts-r1-1eea9ac9-95ca-4d11-b79f-7c69d4b66b96/spans.jsonl</code></td><td><code>d4391bf5cbed6951d2a957cd3a64501e938f98305ccd7c3f5ec36f9c03ee5356</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-prime-ts-r2-f5889ab3-7a4a-4ca8-b980-369a941a00ae/spans.jsonl</code></td><td><code>272f9b5a7b9664f4bf6e1b7c37b22e7e5be20f2e6907f39dd0c6fc626896aae6</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-prime-ts-r3-948a70e8-56f2-4cef-ba59-724aaefec6ef/spans.jsonl</code></td><td><code>4703893cbfd1395dc0224f311d3ae6e62d493d0c7f065165929c47c5f1301e8e</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-wasmedge-aot-r1-2ca142d5-53f6-4450-bbd9-3ec05ca162ca/spans.jsonl</code></td><td><code>d5dbac5f2b590c36f23368eae7e8e39872214bf384462552ca0c37ed8b0e8a85</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-wasmedge-aot-r2-7731dcd9-002d-4213-89b9-d02a0f6dfdf3/spans.jsonl</code></td><td><code>d41c61065e2d4b64f67dbde49202054735692f7e48a646335d79eacfb34f9163</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-wasmedge-aot-r3-73c2c875-f6d3-4c95-beed-d1108545e99d/spans.jsonl</code></td><td><code>62559c0e0f1bacbba847298cd281647a038daafbb659271d70f8a7c1bd048197</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-wasmedge-r1-9ca78de5-e464-448f-84b5-d56dd580faec/spans.jsonl</code></td><td><code>25df1a4e5f233e243a3cfc51a52300c8ab15132c201f54fff1349304bd9eab23</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-wasmedge-r2-f4952b9a-ebf0-4a61-b838-6dbade59f986/spans.jsonl</code></td><td><code>4bc1f2f1095f0335230685003b177e9850ca6f082618427557b8cb4cd557200d</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R04-data-join-wasmedge-r3-2ead9fe4-9e51-49da-9179-0a981d26c0bd/spans.jsonl</code></td><td><code>e0a14b22f6aeaf359830aa3783649990c5367148a34c561707a92a8e844d97d3</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-prime-rust-r1-c6690337-be3b-43db-a34d-b5a96a4ebe9f/spans.jsonl</code></td><td><code>43c28658e627476d62cf9eda2f7477beea0e2c21091cf0252ddd6d46c6ccae6e</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-prime-rust-r2-08f8494f-e884-4207-aa5b-74fc38d2fcd2/spans.jsonl</code></td><td><code>9ebf160d597c56b70a404a74ce5b125a1de901e83a4218942e98382cac8c5deb</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-prime-rust-r3-9aa74dd3-4fd8-4892-b154-dd3a5f0411b4/spans.jsonl</code></td><td><code>4b0b564820f1e4942eb5374c5a3ffca4bd8542e92553b1eb408417e8ffecec29</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-prime-ts-r1-09e97424-e30c-4a3c-a126-58a20133a731/spans.jsonl</code></td><td><code>a0e80101ed7e386e8841424ad1a8c505e55c18a1b1c31b73ce4d3eae6a4f0c3b</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-prime-ts-r2-f93a620d-485c-42bb-9e4b-c72070aa081e/spans.jsonl</code></td><td><code>182b5cfe545ed542104b56ae4232faf990fa766eb6ab21cd6a5a2e50c674fac2</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-prime-ts-r3-ba266109-b977-48aa-bf0c-6b35e402c7ef/spans.jsonl</code></td><td><code>3102cf36770e4aa5aa99acf68e533e46e759d29ec7e9e68ff20baea01fe6df97</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-wasmedge-aot-r1-ee10f062-f9dd-4bd8-a732-618c2f5335f1/spans.jsonl</code></td><td><code>3cb889d192aa143490b25882d2d23cc15411f2406b54d14c529c5c6656fceb15</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-wasmedge-aot-r2-fca9885f-736a-4643-9959-90a8341aab16/spans.jsonl</code></td><td><code>7b27a60f4e6d5f3039622e6ab9dfbf95c8d40e384449a876aed4f1fd85ce8ea9</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-wasmedge-aot-r3-0c6bf337-5f64-489b-8df6-82aa0487b5f6/spans.jsonl</code></td><td><code>c14c40cc67f6f8e6f7c38891152d7466178f4df02d6bf1da916a271ee00b095f</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-wasmedge-r1-55043e70-818c-4dbb-b27a-9278b46c5c3d/spans.jsonl</code></td><td><code>7e676b4638f88c1271db76d3e2ef54cf73465600946282aefb8c0cbcaf979a66</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-wasmedge-r2-8286fb50-f7ec-4746-a2d4-320b78888444/spans.jsonl</code></td><td><code>7e50361aa6ac39cc9b917b79aceae50725c9aa76b932cf96d1b34c5e8ff4f966</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R05-repository-scan-wasmedge-r3-c6ed3932-0bb4-4b6d-b110-3a2368ee9c96/spans.jsonl</code></td><td><code>1dd716687783e5949ca02cfa99b9590378d0716798b52ba66b5d9d2c8d3c46e3</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-prime-rust-r1-7edd0d8e-ec7e-4d85-b2fa-aa3b7acfadda/spans.jsonl</code></td><td><code>c85fe707378e34e09f31860c0b2ec7e4f97a1224b1f60aa86eb634983786dd6f</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-prime-rust-r2-8bc79974-2f72-4bad-9f08-7aca8b3f0412/spans.jsonl</code></td><td><code>8e6b0d25ade7befc890ad4e0ba6305204a69ea11a4d1ae3e7d56f235d0f8d585</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-prime-rust-r3-8572a98c-f813-4ec6-9aaf-15fdeee30a85/spans.jsonl</code></td><td><code>c925cee265847672c9b6a48b71cdc7f750749b5178c8c31f210f49aeef4d806a</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-prime-ts-r1-cb3b950b-49eb-4096-b888-eec82b83bb6b/spans.jsonl</code></td><td><code>5375cd0add1b0fe1055f5597012f7bf12c6876850eee6d31b933b82368bb5ad5</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-prime-ts-r2-0ed91b08-10d2-4c62-866c-43b755a66784/spans.jsonl</code></td><td><code>6da5206a8a541dce26e145cc091c0e65898e05231c490f415f39c1bf97e2448c</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-prime-ts-r3-846cd7df-ff8d-436e-95d1-f0d584e83b30/spans.jsonl</code></td><td><code>7a07f228deac798e9d07e3c3167c160c150b33e4f50acd6a465f8af73af8c741</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-wasmedge-aot-r1-cabb2f60-7d49-42a7-9d57-049e8ff93384/spans.jsonl</code></td><td><code>c712f512a7b8cdb66ad537a34d7b885237ee2fc642951feaa7f9aa1bd3afc021</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-wasmedge-aot-r2-b8935499-a6df-4cfe-8c44-1adfac4d944d/spans.jsonl</code></td><td><code>40e6f82be15a63b093b3af1fd04b8a805772537d37cea6ee3a057e0fae9f356e</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-wasmedge-aot-r3-a786dfc0-b417-4e0a-9166-c14de369cc29/spans.jsonl</code></td><td><code>e53f9a0e8566fbe860646137bd1819814407543bcc1cb3e2b30d787198ee7679</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-wasmedge-r1-99f6a793-3fba-4688-89dd-198354b15540/spans.jsonl</code></td><td><code>7044e6211ac7b780298cd940efb75ebeb5ab64f358b3e606cdf282d7b8466ae9</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-wasmedge-r2-60fadd49-aac7-4aaf-aa06-b88c76c2508d/spans.jsonl</code></td><td><code>2d747af7fb4b5d5e85b417c22b4dbb896c5b0abcf4e0d3e09e8a10ccedf2919a</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R09-bridge-wasmedge-r3-b331f7e4-95ca-4889-8b8b-76bc0044e88f/spans.jsonl</code></td><td><code>7485d4c4bdcd768af9fa5a747759c72b5b7d348276c55c7e39e52bef56257188</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-prime-rust-r1-2cbda2c0-6a48-4c9c-b043-c48c83dcf775/spans.jsonl</code></td><td><code>f07d4255af906dd39ccd8dcf35ba29985f8d0674402e4daebc4341c97293d083</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-prime-rust-r2-79c23729-f5b9-4e14-9777-58c6815836b2/spans.jsonl</code></td><td><code>89d1ab7d871cb8657c361ce013b60fbc8e3c6d7ced59c407b061f82d89d9830e</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-prime-rust-r3-bba0a24f-a5e1-4561-a8ab-fbf1966dbcb3/spans.jsonl</code></td><td><code>cbcc667ffa56613cfe1fc613564d22f8d36c15388df6094c305b8eef09bfcff7</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-prime-ts-r1-86654706-931f-4190-94a4-e6baeb8a55ee/spans.jsonl</code></td><td><code>eac1fc80f9d692f5f25f5c416af6e0171509e815981b3a7a52c9b782aad74ddd</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-prime-ts-r2-b272bb06-58c6-45fe-80f7-80d5d62259d0/spans.jsonl</code></td><td><code>b6ab50660cd6d449b2692c3bfa2b04088a5201dfdbe59e18cef89edfa5ffdde6</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-prime-ts-r3-f23c26da-6632-44fe-be41-14e9dc837fbd/spans.jsonl</code></td><td><code>301ea40b2bd24850b63511b2d12058b9cf1885b1f75086ac350fd65ed1190c66</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-wasmedge-aot-r1-eb96d491-aba2-45d4-b3d8-213f4d11ae12/spans.jsonl</code></td><td><code>b17a09a398d8c87d3e6f20c28aeea029100cc5d560acbce59e367dce3dca59da</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-wasmedge-aot-r2-8b3d8cae-b338-4f51-a506-84e6eb89f4e0/spans.jsonl</code></td><td><code>0e00b3a4ee2486ff2a47e08d1c669a649fa7d9bb5c4387032721bda372a27493</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-wasmedge-aot-r3-d0c96a5a-8876-4db7-94f7-0bf99b0d6ba7/spans.jsonl</code></td><td><code>47bb13cb6ec91a07629ec67b1b5c8041fabbc01587e04912e96e243c39b31935</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-wasmedge-r1-4be897e5-3f10-487b-bef9-5aeb81c051ab/spans.jsonl</code></td><td><code>c1e7a9453d1f81f5a26383fa12548eb6e56772c631eb95ac79fb781716fc074f</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-wasmedge-r2-e8dc1530-3b3a-4f62-8919-0824fa4a170b/spans.jsonl</code></td><td><code>9370bfa25a430cb2bddb1c1946f0602a9a782f7b9a98ba704995c6ab84023e6c</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runs/R12-error-repair-wasmedge-r3-49c78320-dcef-4ee6-8875-34b0f7361165/spans.jsonl</code></td><td><code>0aeb47d8bdb960ab6c903a340387bb00ddbf05cc8819fdd752bee545dad69267</code></td></tr><tr><td><code>poc/bench/results/four-way-aot-bridge-runtime-01/runtime-source.patch</code></td><td><code>1d3ab08c52952036fcb99192070fb468ec8634db40cd206ecb76808bf44b1fc1</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/prepared.json</code></td><td><code>85c08c2ca9b880ea982463f468362dfc9a839e1ffd4c21fefdf82cd48b27c7a5</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/report-provenance.json</code></td><td><code>aa3b43c1cb586db714d3048efd16c853355dd2352659b62b740928c50b7cf951</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/report.html</code></td><td><code>a5f895c0e1554e600bcaf6faa5c0f517d62781131fe099aba278bae2e9a3ef68</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/report.json</code></td><td><code>6ac2c5707f5dd4812e0a52b902a1659ed9464b75e99869c8ed64eac3410df9fc</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/requests.csv</code></td><td><code>f79476ee30ead3ed9ccdea3e92a96178001e1ba5a27eeee8974daa8105ad39fe</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-03-fix-bug-prime-rust-r1-2ea42ac9-cae9-4ea0-a81d-eff9778cd4d8/spans.jsonl</code></td><td><code>b789a210d603da5df935133c68c099fec698e0567d814e28e2bf99d711a4d5e3</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-03-fix-bug-prime-ts-r1-2c685462-6f16-4dad-a3b9-1b730a8a8a32/spans.jsonl</code></td><td><code>a399206d8373b98845e695cc6a589d9a32f0d6b5445c08e9dd8bde2a571f0193</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-03-fix-bug-wasmedge-aot-r1-9da13fa8-68d2-4d37-9a22-db4a04f2f9b8/spans.jsonl</code></td><td><code>3eea8de30ea9d9ade51925b02fbdc944f7a48be8400c1526b1fb282c6fd19aae</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-03-fix-bug-wasmedge-r1-06c5d695-487b-4561-a21b-3808ee68b0c4/spans.jsonl</code></td><td><code>eafc5d12c2a421fa71d9dc9f4c087256723b942c911f3e684511a6dbf8b1f7fb</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-08-rust-rename-prime-rust-r1-9a13501e-8106-41f2-a55a-6df0ae773936/spans.jsonl</code></td><td><code>fa893ffd93fc8cec14d73c8aadfde4d139752e0af20882b4d21308eea253660d</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-08-rust-rename-prime-ts-r1-d28bb1aa-9a80-4128-8f7c-682bd9ad5484/spans.jsonl</code></td><td><code>31223a4c6c41dd016671cd8dc8c4b5fe2883813a68c9f6bc67d265a6736e78e1</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-08-rust-rename-wasmedge-aot-r1-6092838e-0256-4a66-b59b-1cf078c9c664/spans.jsonl</code></td><td><code>b69d2f405baad4b9e160afa290ff03c73b5aa8904f0614b76dbeb2143f9849d7</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-08-rust-rename-wasmedge-r1-8419d7fd-3289-4c03-a5aa-233c6cbe6a8f/spans.jsonl</code></td><td><code>54dd0a8f3e7fb73dcc8004c3108c9015a063c820935a00375e6e1f1fac2b92a6</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-09-helper-accumulation-prime-rust-r1-9b75e06b-c333-47b9-9766-0ed264869f5b/spans.jsonl</code></td><td><code>4be9231d918aa8939c94ad6625877fa89d0f38ff87a4299653f0f3f348094c59</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-09-helper-accumulation-prime-ts-r1-186f7401-b9de-4880-b291-573f2e924df7/spans.jsonl</code></td><td><code>cb51f01ee0dc69d0755062aa9f5e7a9ec2e381c18076ab958f78ce72b79608d7</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-09-helper-accumulation-wasmedge-aot-r1-3ee14f06-e214-4f1b-8f74-93efc9107823/spans.jsonl</code></td><td><code>80b68dcfad3f7d56ea8564adffe942c34661ee8b13b512ace6c9b8716cce7371</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-09-helper-accumulation-wasmedge-r1-9ea1c321-e739-4a3e-8b40-e5b58867e453/spans.jsonl</code></td><td><code>710c2280514b41b1d59291802f844bffc2ec4ee01e489933c6d57da487f3eab7</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-11-join-report-prime-rust-r1-d9cf72f0-4496-465f-ae33-2cede34532f5/spans.jsonl</code></td><td><code>cd5ad63eb884bcf5a7d20eb7f1aa9ac07c7352dd17409e1d5d0dfabd7aa236f0</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-11-join-report-prime-ts-r1-9ed5e52f-d2e7-4f81-9dbe-0983f703a80a/spans.jsonl</code></td><td><code>c32fbe862f6550efa6e8d8c5d8583914685d25e3b1944ab3f1b20c0fcdde02c7</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-11-join-report-wasmedge-aot-r1-f5943f24-d94f-41ce-8097-a38974918851/spans.jsonl</code></td><td><code>2bad9adb6d4121ba9b30119f6b0b19ebc98082b7d85e43f184132e469dab6eb8</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runs/E-11-join-report-wasmedge-r1-834fe42b-d0a8-44cc-9984-3fc70306877a/spans.jsonl</code></td><td><code>995bd6ceb5627cdf39417a5e272704d02a3775a4b41e4f4b764425f52df5f182</code></td></tr><tr><td><code>poc/bench/results/four-way-opus55-aot-bridge-01/runtime-source.patch</code></td><td><code>1d3ab08c52952036fcb99192070fb468ec8634db40cd206ecb76808bf44b1fc1</code></td></tr><tr><td><code>poc/bench/results/three-way-local-02/report.json</code></td><td><code>2d6220fb337f17b024c7cc5f1f297c2143eb5bd4c12cda6d915fcf793db78204</code></td></tr><tr><td><code>poc/bench/results/three-way-opus55-all-cargo-smoke-01/report.json</code></td><td><code>fa7218e506373f0baf952b79871fc6d66171902a866f76decdc3931285ee764f</code></td></tr><tr><td><code>poc/bench/results/three-way-opus55-cell-smoke-01/report.json</code></td><td><code>e00a697ea7aee2f77cd9076a5aa1ff7aab2e9255e4c38fc04bb395da2a1261ab</code></td></tr><tr><td><code>poc/bench/results/three-way-opus55-smoke-01/report.json</code></td><td><code>174687bde304bc19dfac60f8bea3afc0423c2a14aa4c4e7ed99ae2437aa539b7</code></td></tr><tr><td><code>poc/bench/results/three-way-runtime-01/report.json</code></td><td><code>585b6b59bb23a80ca98bcc963ae437c442edc7c0c679c179686c05777833ae69</code></td></tr><tr><td><code>poc/bench/templates/rust-cell-report.md</code></td><td><code>0153a4b026b8ec0638976ee2a33578adf4a9a4014af1952cc811a369ebd21b00</code></td></tr></tbody></table></div></details>

Optional primary reference: [WasmEdge AOT guide](https://wasmedge.org/docs/start/build-and-run/aot/).
