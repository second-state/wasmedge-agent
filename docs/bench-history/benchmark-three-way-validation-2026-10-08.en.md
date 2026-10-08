# Benchmark Validation History — October 8, 2026

The runner, trace collector, runtime adapters, and offline HTML/CSV reports are implemented. The catalog has three host cases, 16 direct-runtime cases, and 12 task cases. The first tests covered all H/R cases and four E tasks. This validates the harness, outputs, and measurement coverage. It does not establish a general speed ranking.

The first paid campaign allowed native tools. WasmEdge E03/E08/E11 used only bash. Those runs cannot answer the Python-cell versus Rust/Wasm-cell question. Their raw records remain saved, but they are excluded from cell comparisons. Later tests require a successful cell in every task turn, prohibit shell delegation, and time the shared checker separately. Earlier chart and deduction checks below are historical records of earlier report versions.

See the [runner instructions](../../poc/bench/three-way/README.en.md), [protocol](../benchmark-three-way-design-2026-10-08.en.md), and [current consolidated report](../rust-cell-report-2026-10-08.en.md). The standalone report includes conclusions, charts, and key tables. Historical dashboards, CSV tables, diagnostics, PNG screenshots, provider requests, SSE, sessions, and generated task outputs remain local.

## Fixed inputs

| Variant | Base revision | Host / cell runtime |
|---|---|---|
| `prime-ts` | `7d442aafa985f9342134fac16c2ef41f03fb45c1` | TS Node bundle / persistent Python |
| `prime-rust` | `967eb13fd488507af5f590e9c6ea8b2672f1fc05` | Native Rust release / persistent Python |
| `wasmedge` | `48d6312570f7d39809703db2c69a43f342fb7424` | Fork TS Node bundle / Rust WASI, interpreter |

Prime Rust changes the host, not the Python cell runtime. Direct upstream tests use identical Python bytes. Rust references implement equivalent operations with assertions. Adapters call the real product engines, not mock runtimes.

Environment: Darwin 25.6.0 arm64, Apple M5 Max, 18 logical CPUs, 128 GiB RAM, Node 24.13.1, Cargo/rustc 1.98.1, and WasmEdge 0.14.1. Rust host, adapter, and guest use release builds. Plans save source/build/task/collector hashes, collector snapshots, seed, and paired order.

Paid tests use `anthropic/claude-opus-5-5` with reasoning off. The service catalog advertises this ID. Its immutable backend revision was not independently verified.

## Initial tests

| Campaign | Slots | Result | Paid requests | Report |
|---|---:|---|---:|---|
| `three-way-local-02` | 57 | R 48/48; H 6 passed, 2 failed, 1 not applicable | 0 | Host/runtime (retained local evidence) |
| `three-way-opus55-smoke-01` | 12 | Four tasks × three variants; all checkers passed; native-tool policy | 54 | Native-tool observation (retained local evidence) |
| `three-way-opus55-cell-smoke-01` | 12 | Checker and per-turn cell rules passed 12/12 | 50 | Cell comparison (retained local evidence) |
| `three-way-command-profile-check` | 1 | Fork R01 passed; 48 Cargo/rustc command spans saved | 0 | Command profile (retained local evidence) |
| `three-way-edit-phase-check` | 3 | R06 passed in all variants; read/transform/write/verify measured | 0 | Edit phases (retained local evidence) |

Paid tasks were E03 fix-bug, E08 rust-rename, E09 helper-accumulation, and E11 join-report. Twelve passing runs do not mean all 12 task types were tested.

Recorded checks at that stage:

- Root checks and workspace build passed. Pinned TS bundles and Rust release hosts/adapters built and ran.
- Collector tests passed 15/15 using faux HTTP/SSE, without paid calls.
- The initial 73 slots had 6,187 schema-valid spans and zero cross-record integrity errors. The later cell campaign is reported separately below.
- R06 read/transform/write/verify durations fit inside the edit transaction. Write time covered write/close, not read, matching, verification, or an fsync guarantee.
- Browser filters worked. A filtered screenshot is saved.
- A scoped scan of 675 paid artifacts found zero occurrences of the actual API key. Build outputs were skipped. Credentials were not written to config, child environment, manifest, or command line.

Trace/stream/edit audit (retained local evidence) and credential audit (retained local evidence) record these checks. Runs retain SSE, decoded arguments, session logs, project outputs, checker logs, and failures.

## Observed failures and limits

H02 replay used 8 KiB context, 64 KiB UTF-8 output, and 64 code points per chunk in a zero-delay burst. Prime TS and the fork exited zero but omitted the final assistant `message_end` in JSON output. Both sessions retained all 65,536 bytes and the marker. Prime Rust delivered and saved the complete result. The two correctness failures remain recorded. Their client root cause was not fixed in this work.

H03 is not applicable to the Rust CLI. It has no separate bash model tool or equivalent tool-filter flags. A shell call inside a runtime was not substituted for host-only dispatch. R10 separately uses the real bridge with a common `/bin/sh` handler.

The first paid native Cargo task used a global shared build directory. It cannot establish cache-controlled compilation latency. Later project targets/build directories are isolated per run. Old outputs are preserved. Native-tool and cell-only policies have different inputs and are not pooled.

All dashboards set `rankingAllowed:false`. Early cells had one repetition, no overhead audit showing ≤2%, and no paired confidence intervals. PATH command profiling adds process overhead and is a separate lane. `cargo test` combines build/test work. Nested rustc unit times cannot be added as Cargo wall time.

Unexposed compiler internals, host phases, CPU, and tree RSS remain missing. Independent duration clocks are not merged into a global timeline. Designed scale, cold-host-cache, recovery, and library-gate extensions were not all implemented.

## First graphical reports

Four initial campaigns were reanalyzed offline, without paid calls. Reports gained case bars, correctness, coverage, phase heatmaps, a single-clock timeline, trace links, and SVG export.

The 12 paid latency bars matched recorded successful medians. H02 failures retained null success medians and a 90,000 ms penalized mean each. H03 Rust remained not applicable. At 390/320 px, pages had no horizontal overflow; wide charts scrolled internally. Heatmap/timeline navigation and SVG download worked. Collector tests then passed 18/18.

Desktop, heatmap, mobile, and visual audit (retained local evidence) are saved. These screenshots show the historical Chinese reports.

## Earlier cell-compilation deduction

The first deduction section removed measured Rust-to-Wasm `cell.compile` time from each successful run, then took the median. Raw bars used the same samples. Other Cargo work was still in the remainder. These adjusted values also retained model and other tool time.

All 73 JSON/CSV deductions matched: 18 runs deducted Cargo; 46 upstream runs had no corresponding phase; five had no Rust cell; three were excluded from successful medians; one was unavailable. R15 parallel compile durations lacked a shared origin and could not be safely deducted. Historical Opus E09 had 689.717917 ms of cell Cargo, 29,427.396583 ms agent time, and 28,737.678666 ms adjusted time. This native-policy run is now excluded from cell comparisons.

Collector tests passed 25/25. Tests covered paired medians, failures, parent/child overlap, missing/duplicate observations, clocks, negative values, and export. Browser checks passed at desktop and 390/320 px. No paid calls were added. See deduction CSV (retained local evidence) and audit (retained local evidence).

## Corrected cell-only test

`three-way-opus55-cell-smoke-01` is a new immutable plan. It ran E03/E08/E09/E11 once per variant, with the same model route and reasoning off. All 50 requests exposed only the appropriate Python or Rust cell tool. All 12 runs passed the checker and per-turn rules. The checker ran after agent completion and is outside agent elapsed time.

There were 32 calls: 28 successful and four repaired failures. All costs remain. Inspection of 34 generated Python/Rust files, including library sources, found no shell/subprocess delegation. E03 Rust used `edit_exact`; other Rust file work used `std::fs`. E09 used the products' real helper/state APIs. Automated source screening is not a proof about arbitrary code.

Single-run agent values below are descriptive. Cell Cargo includes failed builds:

| Case | Prime TS / Python (s) | Prime Rust / Python (s) | Rust raw (s) | Cell Cargo (ms) | Rust adjusted (s) |
|---|---:|---:|---:|---:|---:|
| E03 fix bug | 9.067 | 7.320 | 15.056 | 337.089 | 14.718 |
| E08 rename | 7.556 | 6.435 | 16.840 | 209.671 | 16.630 |
| E09 helper/state | 38.656 | 22.429 | 27.863 | 607.187 | 27.256 |
| E11 join/report | 9.130 | 8.287 | 17.793 | 353.279 | 17.439 |

The revised table separates raw time, deduction, adjusted time, and reason. No Rust-to-Wasm phase does not mean all Python preparation is free. Missing data mean cannot calculate; failed or non-compliant runs mean excluded. Earlier native records retain their phases and checker results but are excluded from cell bars.

Collector tests passed 29/29. All 1,008 new spans passed schema/integrity checks. JSON/CSV arithmetic and checker boundaries matched. A scan of 5,354 non-build/cache files found no actual API key. Desktop, mobile, filters, trace links, and SVG export passed. See cell audit (retained local evidence) and visual audit (retained local evidence).

## Startup and model-trajectory diagnosis

Before the first gateway request, the four Rust runs took 5.195–5.916 s; Prime TS took 0.510–0.538 s; Prime Rust took 0.032–0.037 s. This initialization was inside agent elapsed but outside cell compilation. Synchronous workspace/toolchain/skill work blocked the Node event loop despite fire-and-forget prewarming.

The prepared template lacked websearch, but real sessions mounted it. `syncRustSkills` then ran an `agent_lib` probe build. A separate six-workspace test alternated three no-skill and three websearch cases. Initialization took 0.346–0.389 s without the skill and 4.612–5.048 s with it. Probe Cargo took 4.241–4.650 s. Dependencies rebuilt despite template warming. Reopening the three saved skill workspaces took 0.049–0.055 s without another probe. Wrappers were present and overhead was not audited. Those diagnostic values cannot be subtracted from original paid runs. Startup measurements (retained local evidence).

E11 used the following clipped agent intervals. HTTP intervals were merged. Tool windows excluded HTTP overlap. Nested cells/compiler time were not added again:

| E11 phase (s) | Prime TS / Python | Rust/Wasm |
|---|---:|---:|
| Before first model request | 0.516 | 5.195 |
| Model HTTP requests | 7.058 | 11.939 |
| Tool event windows | 0.011 | 0.483 |
| Other unsplit wait | 1.545 | 0.176 |
| Agent total | 9.130 | 17.793 |

Inside the Rust tool window, Cargo totaled 0.353 s, execution 0.021 s, and snapshots 0.076 s. Python execute summaries totaled 4 ms under a different boundary. Wasm execution does not explain the 8.663 s total gap.

Both variants made three E11 HTTP calls. Rust cell-request output was 774 tokens, versus 341 for Python; whole-task output was 876/439. First prompts were 9,241/11,520 tokens. The slower Rust model path cannot be explained as simply a longer prompt. Server queue, cache, prefill, and generation were not independently timed.

E08 Rust first referenced unavailable `walkdir::WalkDir`, then repaired with `std::fs`: three calls versus two Python calls. E09 Rust used three successful cells and six HTTP calls; Prime TS used eight cells, two API errors, and 11 HTTP calls. Rust took 27.863 s versus 38.656 s. See full attribution (retained local evidence).

Twelve smoke runs mean four cases × three variants × one observation. They identify local costs and failures, but cannot estimate model variance or stable win rates. With n=1, a median is the single value. Formal comparison needs more paired runs, confidence intervals, overhead checks, and initialization Cargo coverage.

## All-Cargo capture and cell execution

`three-way-opus55-all-cargo-smoke-01` is another separate cell-only campaign with the same four cases. It passed 12/12, used 52 paid requests, and made 34 calls: 28 successes, five Python runtime API errors, and one Rust compile error. Inspection of all 36 generated source files found no shell delegation. E09 persistence/helper methods still differ, so this is a product task comparison, not a fixed-program CPU test.

All 12 runs have complete capture of 16 Cargo commands, with timestamps, IDs, arguments, cwd, and three child-clock calibration samples. Agent/user/validated interval merging, clipping, and subtraction matched CSV. All 1,068 spans passed schema/integrity checks. A scan of 5,433 non-build artifacts found no key. All 52 requests exposed only cell tools.

The table uses initialization through checker completion, in seconds. Cargo includes full command wall time, including tests:

| Case | Variant / cell | Raw total | All Cargo | Adjusted |
|---|---|---:|---:|---:|
| E03 | Prime TS / Python | 11.349 | 0.000 | 11.349 |
| E03 | Prime Rust / Python | 7.324 | 0.000 | 7.324 |
| E03 | Rust/Wasm | 14.939 | 4.366 | 10.573 |
| E08 | Prime TS / Python | 9.306 | 0.873 | 8.433 |
| E08 | Prime Rust / Python | 7.331 | 0.415 | 6.916 |
| E08 | Rust/Wasm | 17.624 | 4.534 | 13.090 |
| E09 | Prime TS / Python | 44.481 | 0.000 | 44.481 |
| E09 | Prime Rust / Python | 25.283 | 0.000 | 25.283 |
| E09 | Rust/Wasm | 28.254 | 5.045 | 23.209 |
| E11 | Prime TS / Python | 9.885 | 0.000 | 9.885 |
| E11 | Prime Rust / Python | 8.919 | 0.000 | 8.919 |
| E11 | Rust/Wasm | 18.163 | 4.946 | 13.217 |

Rust initialization skill probes are now captured. Python E08 checker Cargo was 0.873/0.415 s. It is deducted only from validated time. Agent/user periods exclude the checker and have zero checker deduction. Older incomplete ledgers remain unavailable; diagnostic values are not filled in.

Cell totals below are ms, including runtime failures. Counts are success/runtime failure/compile failure. Compile failures have no execution duration:

| Case | Prime TS / Python | Prime Rust / Python | Rust/Wasm |
|---|---:|---:|---:|
| E03 | 6.000 · 2/0/0 | 2.000 · 2/0/0 | 34.297 · 2/0/0 |
| E08 | 3.000 · 1/0/0 | 2.000 · 1/0/0 | 10.877 · 1/0/1 |
| E09 | 23.000 · 6/4/0 | 7.000 · 4/1/0 | 72.601 · 3/0/0 |
| E11 | 4.000 · 2/0/0 | 10.000 · 2/0/0 | 21.060 · 2/0/0 |

Thirty benchmark tests and root checks passed. Tests cover concurrent command unions, boundary clipping, missing/duplicate commands, clock proof, legacy missing data, Python resolution, and runtime/compile failures. One repetition and unaudited overhead prevent a general winner claim.

Dashboard (retained local evidence), Cargo/cell audit (retained local evidence), deductions CSV (retained local evidence), and cell CSV (retained local evidence) are saved.

Browser checks at 1440/390/320 px found no page overflow or JavaScript errors. Period switching, outside-period checker reasons, and execution trace links matched. Added cell bars show per-run totals or successful-cell averages, with linear/log scales and SVG export. Both metrics matched all 12 groups. See the cell-chart audit (retained local evidence). These report updates made no paid calls.

## Runtime diagnosis and later updates

Fixed-program controls used two warmups and 15 measured samples per group. The main diagnosis saved 272 Rust/process and 136 Python samples. Same-artifact interpreter/AOT controls saved 136 more. They identified new-process cost, interpreter JSON/regex cost, and bridge polling delay. E09 state used files, not the bridge. AOT and 1 ms polling were then diagnostic copies. [Full diagnosis](benchmark-cell-runtime-analysis-2026-10-08.en.md).

Later, production readiness reads and trusted host AOT were added. Those four-way campaigns have separate evidence and test counts. See the [AOT/bridge report](../rust-cell-report-2026-10-08.en.md#bridge) and [consolidated report](../rust-cell-report-2026-10-08.en.md). Historical test counts above describe each stage; they are not combined into one suite count.
