# AOT and Bridge Readiness Tests — October 8, 2026

`wasmedge-aot` is a fourth group. The existing `wasmedge` group remains in interpreter mode. Both use the updated bridge. Earlier three-way campaigns and raw files are preserved.

- [Four-way fixed-program dashboard](../poc/bench/results/four-way-aot-bridge-runtime-01/report.en.html): 6 cases × 4 variants × 3 repetitions; 72/72 passed; no paid requests.
- [Four-way Opus 5.5 dashboard](../poc/bench/results/four-way-opus55-aot-bridge-01/report.en.html): 4 tasks × 4 variants × 1 repetition; 16/16 passed; 70 model requests. Responses, SSE, tools, code, and checker records are saved.
- [Alternating bridge measurements](../poc/bench/results/bridge-readiness-diagnostic-20261008-01/measurements.json) and [median CSV](../poc/bench/results/bridge-readiness-diagnostic-20261008-01/summary.csv).

## Fixed-program cell execution

Each value is the median of three per-run cell execution totals, in ms. Cargo and AOT compilation are excluded. Rust includes a new WasmEdge process, module load, VM, guest, bridge, and output drain. Python reuses a resident kernel. A Python 0 ms value is below its integer-millisecond resolution. R04 has two cells; it is not a single parser-body measurement. The dashboard can also show the successful-cell average.

| Case | Prime TS / Python | Prime Rust / Python | Rust / interpreter | Rust / AOT |
|---|---:|---:|---:|---:|
| R01-noop | 1.000 | 0.000 | 18.162 | 15.922 |
| R03-cpu | 5.000 | 5.000 | 10.306 | 8.224 |
| R04-data-join | 8.000 | 6.000 | 293.578 | 21.266 |
| R05-repository-scan | 3.000 | 2.000 | 37.079 | 11.805 |
| R09-bridge | 8.000 | 6.000 | 64.415 | 15.182 |
| R12-error-repair | 1.000 | 0.000 | 9.120 | 8.154 |

AOT reduces interpreter costs for computation, JSON, and regex. It does not remove process and VM startup. The short CPU case is still slower than Python here. The no-op successful-cell average is about 8 ms. This shows a substantial fixed cost for short cells; it does not isolate OS process-launch time.

## Controlled bridge comparison

The test reused identical `diff.rs` and `bridge.rs` source bytes from the earlier diagnosis. It alternated the three modes. Each mode and case had two warmups and 15 measured repetitions. All 102 samples, source/artifact hashes, and AOT provenance are saved. These medians use only this test. They are not pooled with earlier diagnostic medians.

| Cell | Old polling (ms) | Readiness / interpreter (ms) | Readiness / AOT (ms) |
|---|---:|---:|---:|
| One diff / ack | 23.041 | 11.030 | 8.106 |
| 100 echoes × 1 KiB | 652.714 | 65.795 | 11.224 |

Guest-body medians were 12.211 → 0.410 → 0.160 ms for diff, and 639.344 → 53.548 → 3.207 ms for 100 echoes. `poll_oneoff` now waits for stdin readiness or the request deadline. Normal WASI reply reads wake when data arrives, without a fixed 5 ms sleep. Native TCP tests and rare write retries retain their polling.

AOT further reduces guest execution and JSON framing/serialization costs. Compilation took another 2.74/2.76 seconds, excluded from this table.

## AOT and deduction rules

`rustCell.runtimeMode` defaults to `interpreter`; it can also be `aot`. AOT first checks the import policy, strips all guest custom sections, and asks the host compiler to create a native payload. The compiler uses `--interruptible`, plus gas instrumentation when a gas limit is set. Core Wasm must match the inspected input. A missing native payload fails closed. There is no silent fallback and no AOT cache. Skill/library tests still use interpreter mode.

- `cargo.command`: all captured Cargo commands, including initialization, cells, library gates, retries, and common checkers. A `cargo test` deduction includes the whole command.
- `aot.command`: WasmEdge compiler spawn-to-close wall time in a separate ledger and phase. It excludes the Node wrapper's own startup.
- `cell.aot_compile`: host stripping, compilation, output verification, and provenance. It does not overlap the runner's `cell.execution` phase.
- Cell charts use runtime execution only. Deduction charts can show all Cargo, or all Cargo plus AOT. Combined deductions merge overlapping intervals so time is counted once.

AOT output, stripped input, and SHA-256 provenance stay in the host-only `.aot/` directory. The guest cannot mount it. Compilation and execution share timeout, cancellation, and process-limit settings. See the [official AOT guide](https://wasmedge.org/docs/start/build-and-run/aot/) for the payload format and instrumentation. The pinned WasmEdge 0.14.1 CLI loads AOT automatically. Saved command records verify the flags used. No newer run-mode flag was used.

## Validation and limits

At implementation time, `npm run check` and the full workspace build passed. Tests cover AOT stripping, provenance, failure handling, phase separation, Cargo/AOT overlap, clocks, capture, and four-way reference coverage. Real WasmEdge interpreter/AOT integration passed 15 tests: large UTF-8 messages, forbidden socket imports, fresh handshake after timeout, gas exhaustion, and memory-growth caps. Native bridge release tests passed 12/12. Other related suites passed 86 tests and skipped three environment-specific tests. These are the recorded implementation checks, not new tests run for this English edition.

The fixed campaign has 3,822 schema-valid spans, 54 Cargo commands, and 24 AOT commands. Both deduction modes can be calculated for all 72 runs. Wrappers add overhead. Three fixed repetitions and one paid repetition do not provide confidence intervals or a general ranking. Read each result with its workload, cell count, compilation cost, and source.

The paid campaign has 1,600 schema-valid spans, 32 Cargo commands, and eight AOT commands. All 16 runs have complete compiler deductions and meet the cell rules. Its 46 cells include six runtime errors and three Cargo errors. All repair costs are saved. There were no AOT compiler failures. Inspection of generated sources and library edits found no shell/subprocess delegation.

E09's three regex-related AOT commands took 29.31 seconds. This increased total task time. After all compiler deductions, agent time was 25.14 seconds, versus 30.46 seconds for interpreter mode. Programs and cell counts differed. Fixed-source tests provide stronger evidence about runtime mechanisms.
