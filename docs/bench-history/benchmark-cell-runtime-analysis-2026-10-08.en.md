# Why Rust/Wasm Cells Took Longer

This is the diagnosis **before** the AOT and readiness update. In its four paid cases, Rust/Wasm cell execution took longer. The main causes were a new WasmEdge CLI process per cell, forced interpreter mode, and bridge polling in some operations. Cargo was already excluded from the cell chart.

The diagnosis used saved paid sources/traces and local fixed-program controls. It made **zero new paid requests** and did not change the product runtime or original paid records. See the [later AOT and bridge report](../rust-cell-report-2026-10-08.en.md#bridge) for the implemented changes.

## 1. Execution boundaries

| Variant | Measured execution interval | Program and state lifetime |
|---|---|---|
| Prime TS / Python | Execute request to completion in a running kernel | Imports, objects, and regex caches can remain in memory. |
| Prime Rust / Python | Kernel execute request to completion | Persistent Python kernel. Rust is the host language. |
| WasmEdge / Rust | Before `runProcess` to child-process close | New process, VM, and module per cell. State persists in files. |

Rust `cell.execution` excludes Cargo, workspace initialization, the read-only probe, import inspection, snapshots, and bridge cleanup. It includes process startup, module load, VM setup, guest work, stdout/stdio bridge, and process exit. Python startup is separate and is reused. The chart measures actual per-cell product costs, not language-body execution alone.

Relevant source is in the [cell runner](../../packages/coding-agent/src/core/rust-cell/cell-runner.ts), [process runner](../../packages/coding-agent/src/core/rust-cell/process.ts), pinned [Python TS kernel](https://github.com/PrimeIntellect-ai/prime-agent/blob/7d442aafa985f9342134fac16c2ef41f03fb45c1/packages/coding-agent/src/core/kernel/repl-manager.ts), and pinned [Python Rust-host kernel](https://github.com/PrimeIntellect-ai/prime-agent/blob/967eb13fd488507af5f590e9c6ea8b2672f1fc05/crates/pa-core/src/kernel/manager/requests.rs).

## 2. Fixed cost for a near-empty cell

R16 ran 100 marker-only cells in each variant without a model:

| Runtime | Median execution per cell | Detail |
|---|---:|---|
| Prime TS / Python | 0 ms | Integer reporting resolution. High-resolution adapter envelope: 0.136 ms. |
| Prime Rust / Python | 0 ms | High-resolution adapter envelope: 0.132 ms. |
| WasmEdge interpreter | 9.718 ms | Range 9.220–10.466 ms. Excludes Cargo and snapshots. |

Zero does not mean free execution. A new 15-sample control measured Python envelopes of 0.197/0.217 ms, WasmEdge at 10.642 ms, and a new native Rust process at 1.802 ms.

Process startup is inside the measured Rust boundary. No internal hooks split the roughly 10 ms into OS spawn, load, validation, instantiation, guest startup, and exit. Subtracting the native 1.8 ms would not prove that the remainder is VM setup.

## 3. Interpreter costs inside the program

Each group had two warmups and 15 serial measured runs. Rust used release builds. These timers are inside the program, excluding process startup:

| Fixed work | Python / TS host | Python / Rust host | Rust/Wasm interpreter | Native Rust |
|---|---:|---:|---:|---:|
| 100,000 uint32 wrapping operations | 4.725 ms | 4.692 ms | 2.079 ms | 0.109 ms |
| Parse/sum 10,000 JSON records | 4.064 ms, including read | 4.320 ms, including read | 212.394 ms; read 1.840 ms separately | 1.130 ms; read 0.043 ms separately |

The Rust/Wasm integer body was faster than Python. Process cost made the complete cell slower. JSON was slower within the body itself.

Python 3.11.15 used the `_json` C accelerator for `json.decoder.scanstring` and `json.scanner.make_scanner`. Python called native C parsing code. Rust `serde_json` ran as interpreted Wasm. The two parser implementations did not have the same execution mode.

A separate control alternated interpreter and AOT execution of the same trusted artifact, module, program, and data. Each mode had 15 measured runs. AOT compilation was excluded:

| Work | Interpreter cell wall | AOT cell wall | Interpreter body | AOT body |
|---|---:|---:|---|---|
| Near-empty | 8.361 ms | 7.026 ms | No body timer | No body timer |
| 100,000 operations | 10.690 ms | 6.616 ms | 2.022 ms | 0.023 ms |
| 10,000 JSON records | 223.773 ms | 9.009 ms | Parse/sum 211.703 ms | Parse/sum 1.220 ms |
| Equivalent E09 regex/count/state | 31.237 ms | 10.308 ms | Regex creation 4.574 ms; matching 3.484 ms | Regex creation 0.161 ms; matching 0.048 ms |

This directly identifies interpreter execution as a major JSON/regex cost. AOT retained new-process costs. Compilation took 1.407/1.505/1.822/10.810 seconds for the four programs. Short-lived, changing cells cannot obtain that improvement without paying compilation.

At diagnosis time, forced interpreter mode prevented guest-supplied native AOT payloads from bypassing import inspection. The control used trusted local fixtures. A product AOT path needed host compilation from verified Wasm. Removing the flag alone would not preserve the policy. That path was implemented later.

## 4. Reproducible bridge polling delay

The guest bridge slept 5 ms when stdin had no reply, then read again. First use also needed hello/hello_ok. Diff needed emit/ack. A fast host reply could arrive during the guest sleep.

A diagnostic workspace copy changed polling from 5 ms to 1 ms. Modes alternated for 15 measured samples each, with the same handlers, payload, and assertions. All passed:

| Work | 5 ms polling: body median | 1 ms polling: body median | 5 ms polling: process median | 1 ms polling: process median |
|---|---:|---:|---:|---:|
| One diff with handshake/ack | 6.590 ms | 1.647 ms | 15.201 ms | 10.796 ms |
| 100 echoes × 1 KiB, with handshake | 147.509 ms | 62.722 ms | 157.416 ms | 72.664 ms |

This handler returned only `n/payload`. The older R09 handler also returned `cellSourceCode`, so these workloads must not be pooled. A 5 ms sleep does not add exactly 5 ms to every request. No sleep occurs if a reply is ready at the first poll. Scheduling also changes the delay. The causal comparison uses the final alternating samples only.

The 1 ms change was a diagnostic perturbation. The proposed product fix was fd readiness with a deadline, cancellation, and timeout behavior. The later implementation uses that approach.

## 5. Explanation of the paid cases

| Case | Actual Rust execution, ms/cell | Confirmed mechanism |
|---|---|---|
| E03 bug fix | 9.872, 24.425 | First cell lists files. `edit_exact` in the second cell also calls `rlm::display::diff`, with handshake/ack. Python uses pathlib replacement/write. |
| E08 rename | 10.877 | Close to the near-empty process floor. The earlier compile error never executed and is outside execution totals. |
| E09 helper/state | 29.964, 30.873, 11.765 | The first two processes rebuild regex, scan logs, and read/write state. The third loads state and formats output without regex. |
| E11 join/report | 9.455, 11.604 | Small fixture; two process starts matter. The larger 10,000-record diagnostic cannot replace these measurements. |

`rlm::state` reads and writes [state files](../../wasmedge-agent-runtime/template/rlm/src/state.rs). It does **not** use the host bridge. In the equivalent E09 diagnosis, regex creation took 4.347 ms, first captures/matching 3.399 ms, state write 0.640 ms, and log read 0.101 ms. A separate state write/read measured 0.582/0.132 ms.

These timers do not partition the full guest. Load, allocation, destruction, output, and other work remain unsplit. The paid sources lacked body timers, so their exact breakdown cannot be recovered later. Different variants also used different programs and cell counts. Product charts describe those task paths; fixed-program controls explain mechanisms. Their values cannot be subtracted to fabricate an original run's startup or body time.

## 6. Priorities and saved evidence

1. Remove fixed bridge sleep. Test diff and request/reply deadlines, aborts, and broken pipes.
2. Evaluate an embedded runner or worker reuse, while keeping fresh cell instances and isolation. Cargo changes alone will not remove process startup.
3. Test trusted AOT/reuse for JSON and regex, or native host services. Report compilation and amortization separately. Host services still incur bridge and serialization costs.
4. Define lifetimes for reusable helpers, data, and compiled regex. Persistent Python and new Wasm processes have different cache behavior.

Evidence: main measurements (retained local evidence), reproducible source (retained local evidence), same-artifact AOT control (retained local evidence), and original paid dashboard (retained local evidence).

The main diagnosis saved 272 Rust/process and 136 Python samples, including warmups. The AOT control saved 136 samples. Each comparison excludes two warmups and uses the median of 15 measured samples.

`cell-runtime-diagnostic-20261008-01` stopped after a regex-escape error in the diagnostic script. It is saved and excluded. Valid controls come from `-02`, with hashes, output, assertions, and completion markers. No profiler-overhead audit or cross-machine validation was done. The results concern these programs on this host with WasmEdge 0.14.1.
