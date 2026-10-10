# Benchmark workloads for evaluating Rust cell advantages

Date: 2026-10-10. Status: N01/N03/N04 are implemented, and all 180 fixed-algorithm pilot runs across four variants passed. N02/N05/N06 remain designs.

[Offline charts and complete conditions](benchmark-rust-cell-workloads-2026-10-10.html) · [Portable aggregates and source hashes](bench-data/workloads-pilot-2026-10-10.json) · [Runner instructions](../poc/bench/three-way/README.en.md)

These benchmarks identify workloads where Rust cells can offset compilation, process/VM startup and persistence costs. Prioritize custom per-record logic, graph traversal and dynamic programming, then measure resource use across sessions. Each case has scale curves, correctness checks and Python baselines using reasonable standard-library facilities and data structures. Measurements retaining actual costs determine whether an advantage exists.

## Existing results and hypotheses

In the six fixed cases in the [October 8 consolidated report](rust-cell-report-2026-10-08.en.md#runtime), median Python-cell totals were 0–8 ms and Rust/AOT totals were 8.154–21.266 ms. R01 and R04 each contain two cells; the whole table is not per-cell timing. Those values exclude compilation, initialization and snapshots, while retaining Python's resident kernel versus Rust's new process/VM per cell.

[Historical fixed-program diagnostics](bench-history/benchmark-cell-runtime-analysis-2026-10-08.en.md) measured a guest body of 100,000 uint32 operations at approximately 4.7 ms in Python and 2.1 ms in the Wasm interpreter. This supports testing larger custom computations, but does not establish speedup for newer versions, other algorithms or complete tasks. Python JSON can use a C accelerator; a larger JSON fixture alone does not guarantee a Rust advantage.

The product defaults to the interpreter, supports opt-in AOT and uses the readiness bridge. **AOT recompiles every cell, with no artifact cache.** Batching more work into one cell can amortize that cell's cost. Cross-cell AOT reuse is a future experiment, not a current capability. This follows [DESIGN D9, D11 and D18](../DESIGN.md): trusted AOT, short-lived cells and child-workspace semantics.

Hypotheses:

1. Custom loops that cannot readily use existing C functions may outperform Python in full cell time at sufficient scale, in the interpreter or AOT.
2. One substantial batch per cell may favor Rust more than many short cells. Actual product benefit depends on the agent forming such batches.
3. Short-lived Wasm processes may reduce idle-session memory, while Cargo/AOT peaks and concurrent queueing may offset the benefit.

## Variants and timing boundaries

Use the existing four variants: `prime-ts`/Python, `prime-rust`/Python, `wasmedge`/interpreter and `wasmedge-aot`/AOT. The two TypeScript-host families provide the main runtime comparison; Rust-host/Python is an additional product comparison. Retain source revisions, runtimes, compilers, dependencies, flags and source/fixture hashes. Use the same machine and fixtures for all variants.

This campaign compares fixed algorithms in Python's standard library and Rust. Package-optimized comparisons are separate future experiments:

| Comparison | Implementation contract | Question answered |
|---|---|---|
| Fixed algorithm | Same algorithm, arithmetic, workload and stopping conditions; Python uses reasonable standard-library facilities, buffers and data structures | What changes when custom computation moves to Rust/Wasm? |
| Practical optimization | Each language may use available packages/faster algorithms, preserving the same output contract | Does a user completing this task actually benefit? |

Report these separately. Beating handwritten Python does not establish an advantage over the Python ecosystem. Pin package versions and verify semantics/WASI compatibility. Report dependency installation, vendoring and build costs separately, including necessary preparation in first-use totals. Explain unavailable packages rather than deliberately weakening the baseline.

| Metric | Boundary and purpose |
|---|---|
| Guest phases | Read, parse/index, compute and write measured with local monotonic timers; explains the mechanism |
| Cell execution | Direct product-runtime execution, excluding Cargo/AOT, initialization and snapshots; Rust retains process/VM startup, I/O and output collection, while Python uses a resident kernel |
| Cell roundtrip | Submission through complete result, including Cargo/AOT, queueing, policy and snapshots; primary warm-session latency |
| First validated total | Before runtime startup through the common checker, including initialization, all cells, repairs and validation; fixture preparation is separate |
| Resources | Time series for host, kernel/guest, compilers and descendants: CPU, peak/idle memory and workspace disk |

Guest phases are nested in cell time and are not additive. Phase medians cannot reconstruct the median total. Compilation deductions are diagnostic; headline results retain actual roundtrip/total costs.

Use Python `time.perf_counter_ns()` and Rust `Instant`, rather than integer milliseconds for sub-ms claims. Guest clocks yield local durations and cannot be joined directly to the collector timeline. See the [Python timer documentation](https://docs.python.org/3.11/library/time.html#time.perf_counter_ns). Do not replace product timing with default `timeit`, which suspends garbage collection and excludes setup; retain normal GC. See [timeit documentation](https://docs.python.org/3.11/library/timeit.html).

## Six proposed cases

These scales are pilot starting points, not observed crossover thresholds. Run from small to large, then fix the formal matrix. Use identical work across variants. Keep common-timeout outcomes when large workloads fail to finish; do not retain only Rust completions. Proposed dimensions below are distinguished from the implemented first-batch contract later in this document.

| ID | Task | Scale axes | Main hypothesis | Priority |
|---|---|---|---|---|
| N01 | Dependency graph impact | 1k/10k/100k nodes, 4V/16V edges, 1/32/256 queries | Custom traversal and compact layouts | First batch |
| N02 | Batched fuzzy matching | 1k/10k/50k candidates, 1/8/32 queries, 32/64 characters | Dynamic programming and fine-grained computation | Second batch |
| N03 | Event state machine and rule validation | 100k/1m/10m events, 10/100/1,000 active keys | Per-record branches, state updates and streaming | First batch |
| N04 | Discrete integer simulation | 10k/100k/1m trajectories, 256 steps each | Long reproducible loops with branches | First batch |
| N05 | Large code lexical index | 1k/10k/50k files, approximately 10/100/500 MiB | Custom scanning, batching and memory | Second batch |
| N06 | Concurrent and idle sessions | 1/4/16/32 sessions, 10/50 cells | Idle memory, capacity and successful throughput | Second batch |

Avoid a full Cartesian product. Sweep one axis at middle values first, then test small/medium/large complete configurations. Record actual pairs, visited edges, events and bytes rather than hiding work behind a single N.

### N01: dependency graph impact

An agent reads dependencies and finds targets affected by changes to specified modules. Input pairs are `(depender, dependency)`; reverse adjacency points from dependency to depender, and results include the root. Seeded directed graphs include cycles, self-loops, repeated edges, isolated nodes, long chains and high fan-out. The initial proposal returns reachable-node counts and canonical digests, with full sets for small fixtures; the implementation below strengthens this to complete bitmaps at every scale.

The fixed algorithm builds adjacency/CSR once and uses iterative BFS. Both implementations reuse visited scratch buffers. Python uses `deque` or a queue with a head index, avoiding `list.pop(0)`. Run all queries in one cell. Read input files at runtime so compilation cannot precompute results.

**Acceptance:** an independent simple set traversal constructs expected results and confirms root inclusion. The proposed digest version fixes serialization/hash rules and reports sorting/hashing separately. The implemented version checks every output bit.

**Report:** graph-build and traversal time, queries/s, actual visited edges, working memory and complete roundtrip. If an advantage appears only between compact Rust CSR and Python objects, add compact Python representation. Such a result supports a layout difference, not an intrinsic language claim.

### N02: batched fuzzy matching

Find the nearest 20 filenames or error signatures. Read inputs at runtime, primarily using a fixed ASCII alphabet, with additional Unicode correctness fixtures. Use unit-cost Levenshtein distance and sort by `(distance, candidate_id)`; do not mix similarity scores.

Use two-row dynamic programming and the same top-k method. Report unpruned and identically cutoff-pruned versions separately. Both implementations reuse buffers rather than allocate per pair.

**Add RapidFuzz for a practical comparison**, preserving distance, cutoff, preprocessing and ordering. Its [official API](https://rapidfuzz.github.io/RapidFuzz/Usage/distance/Levenshtein.html) exposes exact distances and cutoffs. This comparison may use a different algorithm but retains the common output contract.

**Acceptance:** independently check all small-fixture distances with full-matrix DP. Check complete top-20 IDs/distances for larger fixtures, including ties, empty strings, insertion, deletion and substitution. Unicode units are scalar values; Rust UTF-8 bytes cannot be compared with Python characters.

**Report:** pairs/s, actual DP updates, memory and complete roundtrip. If Rust beats handwritten Python but loses to RapidFuzz, limit the claim to custom DP; it does not establish practical search acceleration. Keep common-timeout failures at maximum scales instead of shrinking one variant's data.

### N03: event state machine and rule validation

Analyze event streams for successful transactions, illegal ordering, duplicate sequences and timeouts using event kind, current state and context. Fix transitions, time units, ordering, duplicate rules and counters per key. Use integers to avoid floating-point ambiguity.

Primary input uses 32-byte little-endian records: `timestamp_ms: u64`, `key: u32`, `seq: u32`, `amount: i64`, `kind: u8`, seven padding bytes. Python uses `struct.iter_unpack`; Rust uses buffered reads and little-endian decoding. Carry incomplete records across chunks and apply the same rules to every record. A separate JSONL condition represents identical events, reporting parsing cost separately. Do not compare Rust binary input with Python JSONL in one speedup chart.

Each key starts Idle with no last sequence. If `seq <= last_seq`, count only a duplicate; otherwise update last sequence. Primary timestamps are globally nondecreasing. An Open state older than 30,000 ms first times out, discards pending amount and returns Idle. START accepts Idle→Open and initializes start time/pending amount. CHARGE requires Open and nonnegative amount. COMMIT adds Open pending amount to the successful total and returns Idle. CANCEL discards pending amount and returns Idle. Other transitions count invalid and retain current state. Fixtures prevent i64 accumulation overflow. Unknown kinds and truncated-record checks are separate.

Proposed distributions include mostly valid transitions and mixed/anomalous transitions. Keep active-key counts identical. Both implementations stream; Python need not materialize the file. Output anomaly counters, final per-key states and total amounts, with small fixed stdout.

**Acceptance:** stepwise oracles for small traces and complete per-key summaries for large fixtures. Cover chunk boundaries, final truncated records, unknown kinds, duplicate sequences and exact timeout boundaries. Score malformed-input conditions separately.

**Report:** decode and transition time, events/s, peak memory and complete roundtrip. This tests custom conditional logic. Retain slower interpreter results in JSONL conditions too.

### N04: discrete integer simulation

Evaluate scheduling/resource policies through trajectories whose next state depends on previous state. Fix a u32 PRNG, explicit wrapping and bounded integer states.

Use `x = (1664525*x + 1013904223) mod 2^32`. The high two bits choose an event; queues start at zero with capacity 64. Kinds 0/1 enqueue or reject at capacity. Kind 2 services one queued item, increasing completed. Kind 3 expires one item, increasing expired. Output final queue/completed/expired/rejected and verify conservation against arrivals. Seed and initial-queue variants are separate conditions.

One cell handles a full batch with distinct seeds from input files. PRNG/update order is identical. The proposal requires final output consumption and Rust `black_box` where needed to prevent eliminated work. A separate condition reads pregenerated events and performs only bounded queue updates, testing whether gains depend on Python PRNG/masking costs; input I/O remains timed.

Python uses the same per-item update algorithm and standard library. NumPy comparisons are excluded.

**Acceptance:** independent stepwise checks of small trajectories. The initial proposal combines canonical terminal-state digests, event histograms and resource balances for large cases; the implemented first batch checks every terminal value directly. Verify different seeds rather than a single checksum demonstration.

**Report:** steps/s, transition distributions, compute time and complete roundtrip. Retain all AOT compilation costs. Only trajectories within one cell share that compilation; the next cell recompiles.

### N05: large code lexical index

Build an identifier index excluding strings/comments, with counts and the first 20 locations per identifier. Identifiers follow `[A-Za-z_][A-Za-z0-9_]*`. Positions are UTF-8 byte offsets; locations sort by `(relative file path, offset)`. Fix scanner grammar for single/double quotes, escapes and line/block comments; other punctuation separates tokens. Primary inputs omit template and regex literals. This is lexical indexing, not full TypeScript semantic analysis.

Compare one large file with many small files at identical total bytes to distinguish scanning from WASI filesystem costs. Include length distributions, tokens spanning buffers, long comments, escaped quotes and files without final newlines. Both variants use buffered I/O, the same scanner and chunk size.

**Acceptance:** compare every token in small golden corpora and complete-index canonical digests/total tokens in large fixtures. Fix malformed-token error-position rules. A practical parser-package condition first needs equivalent grammar/position units; it cannot silently replace the scanner.

**Report:** MiB/s, tokens/s, open/read counts, peak memory and full roundtrip. This tests custom lexical logic. Keep simple `grep` or filename rewrites as controls.

### N06: concurrent and idle sessions

Maintain multiple sessions on one machine, alternating computation and waiting. Use medium N01/N03 work fixed after the pilot, with equal workloads and distinct seeds. Do not vary work by variant or measure only guest processes.

Two separate campaigns:

1. **First use:** create 1/4/16/32 sessions simultaneously; record ready latency, first validated output, build queueing, peak memory and CPU. State the prepared-template condition; measure clean installation separately.
2. **Long-lived sessions:** initialize first, then run 10/50 cell cycles with predefined active windows and 30-second idle windows. Python retains its natural resident kernel. Compare both discard-temporary-data and retain-required-assets contracts in all variants, counting Wasm state/blob I/O and Git snapshots.

Retained assets use equivalent 64 KiB/16 MiB/64 MiB data per session; subsequent cells must actually use and validate it. Python may retain memory naturally or persist explicitly in a practical version. Do not require useless large objects to manufacture a Rust idle-memory advantage.

**Acceptance:** validate summaries, state, session IDs and isolation across all sessions. Timeouts/cancellations do not count as completions. These are independent sessions. Parent/child trees require a separate campaign retaining parent snapshots, workspace copying and builds. Do not assume Rust threads/Rayon work in the current WASI runner.

**Report:** successful work units/s, median/distribution of latency, memory time series, idle/peak memory, memory-time integral and target/state disk growth. Fix and record Cargo build concurrency, retaining its queueing cost.

On Linux, use PSS or independent cgroup charged memory and specify page-cache scope. On macOS, sampled summed RSS must disclose shared-page double counting and missed short-lived compiler peaks. Retain sampling intervals; do not call it exact physical peak memory. Lower Rust idle memory establishes a session-capacity advantage, not lower single-cell latency.

## Batch size and crossover curves

Beyond one large cell, fix total work W for N01/N03/N04 and partition it into 1/4/16/64 cells. Compare independent batches reading their own shards with batches retaining indexes/state needed later. Python may retain memory; Rust uses current state/blobs. Count loading, serialization and snapshots without forcing Python to reparse.

Keep identical total work, outputs and correctness at every batch size. Separate model-selected cell counts; fixed counts explain lifecycle cost.

For one cell:

```text
T_rust(W) = O_rust + C_cargo + C_aot + G_rust(W)
T_python(W) = O_python + G_python(W)

Rust wins when:
G_python(W) - G_rust(W) > O_rust - O_python + C_cargo + C_aot
```

O includes other costs inside the selected roundtrip boundary. First use additionally includes initialization; interpreter C_aot is zero. G includes case-specific reading, parsing, computation and writing, including Python imports and Rust rereads.

Estimate a crossover only when G is approximately linear over the tested range and Rust is faster per work unit. Confirm formal thresholds with paired measurements near the crossing. If Rust never wins, report that this mode/workload did not break even. R cells incur all R actual compilations; they cannot share one AOT charge.

Plots should include work scale versus roundtrip, complete phases, fixed work versus cell count, and N06 memory/throughput. Guest-only speedup alone does not establish product benefit.

## Execution and interpretation rules

1. **Offline pilot first:** N01/N03/N04, small/medium/large × four variants × five paired blocks, retaining existing noop, JSON join and short file-edit controls separately. Separate fresh and started-workspace conditions. Blocks share fixture seeds and rotate variant order instead of exhausting one variant first.
2. **Fix the formal matrix:** choose scales/timeouts and find errors in the pilot, then use new fixture seeds. Start warm conditions with two full warmups and 30 paired blocks. Provision fresh cold workspaces without warming them first. Rust still calls the product cell API using release/offline builds and retains admission, AOT and snapshots. Python keeps natural residency.
3. **Preserve environment/raw evidence:** hashes, sources, stdout/stderr, compiler commands, queueing/phases, outputs and failures. Do not embed answers in source. Keep expected outputs in host-only oracle directories inaccessible to guests/models. Independent oracles must not copy the same implementation. Audit instrumentation on/off under the existing formal-ranking overhead requirement: 95% upper bound ≤2%.
4. **Require correct completion:** report every scheduled slot, failure, timeout, cancellation and completion rate alongside successful latency. Compute paired roundtrip ratios/differences and 95% confidence intervals, clustering resampling by seed when seeds repeat. Intervals cover this host/fixed workload only. Thirty-block tails are descriptive; formal p95 needs at least 100 blocks and stability checks.
5. **Separate performance claims:** guest-only, warm roundtrip, cold validated total and idle capacity. The proposed practical threshold is at least 20% lower median roundtrip, a paired speedup 95% lower bound above 1, and all deterministic checks passing. This suite rule does not change DESIGN D20/D21.
6. **Validate the agent last:** after finding favorable fixed-program scales, ask the same model to complete N01/N03/N04 user tasks from full fixtures without a supplied solution. Use identical acceptance, allow reasonable model-selected cell counts, and retain requests/tokens, compile/runtime errors, repairs and completion time. Choose repetitions from independent pilot variance. Fixed-program gains do not establish agent gains. Paid E2E is a separate campaign.

## Harness implementation scope

The [three-way harness](../poc/bench/three-way/README.en.md) now includes first-batch N01/N03/N04 reference programs, fixtures and common checkers. `workloads` is opt-in; existing runtime cases remain unchanged.

- `cases.ts` supports four-variant runtime steps and parameters for scale, seed, batching, algorithm and cache conditions. Existing paid tasks are not overwritten.
- `runtime.ts` captures `cell.roundtrip`, runtime phases and `BENCH_PHASE`. New cases verify full artifacts/oracles rather than only `BENCH_OK`.
- Large/binary fixtures use a generator and file manifest; existing string-valued fixture maps should not embed 500 MiB in plan JSON.
- N06 requires coordinated execution, active/idle barriers, complete process-tree sampling and idle records; a single peak per run is insufficient.
- Reports add scale/batching, runtime execution, failures and crossover diagnostics. Trusted AOT remains in the product pipeline. [WasmEdge AOT documentation](https://wasmedge.org/docs/start/build-and-run/aot/) describes a separate compilation step, not an agent cache. Validate flags against pinned 0.14.1 rather than assuming newer documentation applies.

The first delivery is reproducible N01/N03/N04, independent oracles, four-way offline paired results and curves retaining full costs. If only guest execution wins, measurements determine whether trusted caching or runner improvements are justified; do not redefine benchmark boundaries to create a win.

### Implemented first-batch contract

Programs, generators and reports reside in `poc/bench/three-way/workloads/`. N01 fixes 4V edges and 64/128/256 queries and emits complete canonical bitmaps. N03 emits complete cumulative per-key state per batch. N04 emits every terminal state, 16 bytes per trajectory. Large outputs are fully checked, not reduced to one checksum. Oracles use set DFS, object state and independent integer computation, with handwritten golden tests.

N03 uses mixed/anomalous events; valid-transition distribution sweeps remain unimplemented. Binary decoding, transitions and I/O share `guest.stream_compute`, without a pure-CPU claim. N04 includes pregenerated-event controls with Python stdlib only. Total work can be split into 1/4/16/64 cells: N01/N03 preserve needed indexes/state; N04 batches are independent. Warm conditions execute at least two complete cycles, retaining and validating every warmup batch.

Model-generated `workloads-e2e` is separate; see the [Opus E2E record](benchmark-rust-cell-e2e-2026-10-10.md) for requests, results and earlier service errors. These fixed-program results have no model calls and remain preserved. N06 concurrency/idle sampling, formal confidence intervals, overhead auditing, complete axis sweeps and crossover fitting remain unimplemented. Current validated total includes runtime disposal; full `cell.roundtrip` is reported separately. Do not apply this boundary retroactively to old results.

### Measured pilot results

Campaign `workloads-pilot-01` includes three cases × three scales × four variants × five paired repetitions = 180 reference runs. All passed with no timeouts or paid requests. All 45 paired fixture groups have matching hashes; work counters, per-batch oracles, compiler capture and clock calibration were audited. Python variants share source, as do Wasm variants. Another 60 historical control records remain in raw evidence, excluded from tables, curves and speedups.

Environment: Apple M5 Max, macOS arm64, Node 24.13.1, Python 3.11.15, Cargo/rustc 1.98.1 and WasmEdge 0.14.1. OMP/OpenBLAS/MKL/NumExpr thread limits are one. Each run uses a fresh workspace with prepared template/toolchain and retained OS caches. Every Rust cell invokes Cargo; every AOT cell recompiles. `task.fixture_generate` records fixture/oracle preparation separately, outside these timings. Product startup, compilation and snapshots remain included where applicable.

**Large complete-cell roundtrip medians, seconds, n=5:**

| Case and work | Python/TS host | Python/Rust host | Wasm interpreter | Wasm AOT |
|---|---:|---:|---:|---:|
| N01: 100k nodes, 400k edges, 256 queries | 5.784 | 5.792 | 22.069 | 8.246 |
| N03: 10m events, 1,000 keys | 1.529 | 1.537 | 12.401 | 9.324 |
| N04: 1m trajectories × 256 steps, reference | 14.221 | 14.242 | 27.478 | 8.040 |

**Large runtime-execution medians, seconds, n=5; excludes Cargo/AOT, initialization and snapshots:**

| Case | Python/TS host | Python/Rust host | Wasm interpreter | Wasm AOT |
|---|---:|---:|---:|---:|
| N01 | 5.784 | 5.791 | 17.014 | 0.419 |
| N03 | 1.529 | 1.536 | 7.335 | 0.247 |
| N04 | 14.220 | 14.241 | 22.466 | 0.658 |

Execution is measured directly and retains process/VM startup, I/O and output collection. It is not roundtrip median minus compiler medians.

N04 reference has a **median paired AOT/Python-TS roundtrip speedup of 1.779×**, including Cargo/AOT. Startup through complete acceptance/disposal has medians of 8.700 s for AOT and 14.379 s for Python-TS, a separate boundary. Table roundtrip/validated total **do not deduct Cargo or AOT**. Runtime execution uses `cell.execution`/`cell.python_execute`, excluding both compilers, initialization and snapshots but retaining runtime startup/I/O. Compute also excludes compilation but covers guest algorithm work, with N03 decoding/I/O included. N04 guest-compute medians are 0.645 s AOT and 14.215 s Python-TS. AOT's Cargo/AOT phase medians are approximately 4.747/2.596 s; phase medians are not additive.

This pilot found **an AOT advantage for large custom integer loops**. N01/N03 and the default interpreter did not win complete cell time. This does not establish that Rust cells are universally faster or that model-generated agent tasks benefit. Small/medium results and every failure column remain in the report, without presenting only large successes.

Warmup, four-cell batching, cross-cell graph/event state, JSONL and pregenerated events have separate correctness smokes, excluded from this cold timing pool. Formal ranking remains false: five paired blocks are descriptive, without confidence intervals, overhead audits or formal measurements near crossover. Raw traces, stdout, sources, outputs and compiler commands remain local and ignored; Git retains aggregates and HTML readers.

## Table columns and interpretation

Times are in ms. The definitions below are shared with the offline HTML report.

| Column | Definition and timing boundary | How to read it |
|---|---|---|
| Condition | Complete condition ID: case, scale, cell batches, workspace state, algorithm variant, input format and simulation mode. | For example, N04-simulation-large-b1-cold-reference-binary-prng means large integer simulation, one measured cell, a fresh workspace, the fixed algorithm, binary seeds and guest-generated PRNG events. Compare variants only under identical conditions; do not pool different conditions. |
| Work | Total work per run, not per cell. N01 lists nodes/edges/queries; N03 lists events/active keys; N04 lists trajectories × steps. | b4 partitions the same total work into four cells; it does not multiply work by four. Confirm equal work before comparing time. Guest counters and the full-output oracle verify the work actually completed. |
| Variant | Host and cell-runtime combination: prime-ts = TypeScript host + Python cell; prime-rust = Rust host + Python cell; wasmedge = TypeScript host + Rust/Wasm interpreter; wasmedge-aot = the same host + Rust/Wasm AOT. | The Rust in prime-rust describes the host, not the cell. The main runtime comparison is prime-ts versus the two wasmedge variants; prime-rust also reflects host differences. Both Python variants share source, as do both Wasm variants. |
| Passed / planned | Runs passing full acceptance / runs scheduled in the manifest. Each run must finish normally, have successful and fully measured cells, pass complete per-batch output and input-integrity checks, and validate warmup outputs too. | 5/5 means all five paired repetitions passed. Timing columns take per-run totals first, then the median of successful runs with valid measurements. Charts also show the metric's sample count n. Successful latency does not establish completion rate. |
| Failed / missing | All scheduled runs that did not pass: checker/runtime failures, timeouts, infrastructure errors, and unexecuted or unrecorded slots. Equals planned minus passed. | This combines failures and missing records; raw results/traces retain the detailed classification. Unsuccessful runs have no successful latency. Do not fill them with zero or discard them to claim a win. |
| Timeouts | Number of runs with recorded timedOut=true. | A subset of Failed / missing; do not add it again. Zero means no recorded timeout, not that missing slots ran or all runs passed. |
| Roundtrip (includes Cargo/AOT) | Wall time from measured cell submission to the complete result. Includes adapter/host communication, admission/queueing, source/policy processing, Cargo, AOT, runtime execution, snapshots and cleanup. Excludes initial runtime startup, warmups and the host oracle after cell return. | Sum measured cell roundtrips within each run, then take the median across successful runs. This is actual cell submission latency with Rust compilation retained. b4 reports the sum of four calls, not an average cell. |
| Runtime execution (excludes Cargo/AOT) | Direct runtime cell.execution/cell.python_execute measurements. Excludes Cargo, AOT, runtime initialization, host admission and snapshots. Rust still includes a new process/VM, input reads, guest work, bridge waits and output collection; Python uses a resident runtime. | Compares work inside the execution boundary. This is neither all remaining roundtrip cost after subtracting compilation nor pure CPU time. Python and Rust process-lifecycle differences remain. |
| Compute (excludes Cargo/AOT) | Algorithm phase measured by the guest's monotonic timer. N01 covers traversal and bitmap creation, excluding index build/load and output writes. N04 covers PRNG/state updates and result-buffer creation, excluding input reads and output writes. N03 combines streaming decode, I/O and transitions. | Explains algorithm cost and does not establish product speed on its own. N03 is not pure computation/CPU. Guest durations use local clocks and cannot be assembled into the collector timeline. |
| Cargo | Sum of runtime-reported Rust-to-Wasm Cargo build phases in measured cells, then median across runs. Uses release/offline builds. | Not applicable to Python, shown as —. This is not all Cargo commands in the run and excludes warmup/initialization Cargo. Compilation-excluded charts instead use calibrated command wall intervals, not subtraction of this column's median. |
| AOT | Sum of runtime-reported host AOT phases in measured AOT cells, then median. Includes trusted Wasm-to-native compilation and associated phase work. | Applies only to wasmedge-aot; Python and the interpreter show —. Every AOT cell recompiles, including in warm workspaces, with no artifact cache. Deduction charts use aot.command intervals. |
| Snapshot | Sum of runtime workspace/Git snapshot phases after measured Rust cells, then median across runs. | This experiment has no equivalent Python runtime snapshot phase, so Python shows —. This does not include all state/blob I/O: guest serialization and blob I/O remain in runtime execution. Compilation-excluded roundtrip retains snapshots. |
| Validated total (includes Cargo/AOT) | Wall time from before runtime startup to run acceptance completion. Includes initialization, warmups, measured cells, all Cargo/AOT, per-batch host oracles, input-integrity verification, runtime disposal and other host work during that period. | Fixture/oracle generation precedes this boundary and is recorded separately as task.fixture_generate. This is the total cost of a validated result. Warm validated total still includes warming costs and is not pure hot-cell latency. |

- Times are in ms; lower is faster. Sum measured cells within each run, then take the median across repetitions. Values are not averages per cell.
- — means not applicable, no valid samples, or missing measurement; it is not zero. Raw records retain missing reasons and failures. Chart n counts successful runs with valid data for that metric.
- Roundtrip contains runtime execution, which contains compute. Cargo, AOT and snapshot are also parts of roundtrip. These columns are not independent additive costs; phase medians cannot reconstruct the median total.
- Compilation-excluded charts are diagnostic. Compilation-inclusive roundtrip/validated total retain actual cost. Five paired repetitions are descriptive; confidence intervals and instrumentation overhead remain unaudited.

## Charts excluding Cargo and AOT

The report selects five timing boundaries, each with N01/N03/N04 scale charts. Default: roundtrip minus Cargo/AOT. Other choices: directly measured execution, compute, validated total minus compilation and compilation-inclusive roundtrip. Charts use independent linear scales; n counts successful runs with valid measurements for that metric.

Per run, merge calibrated `cargo.command`/`aot.command` intervals, clip them to measured cells or validated time, deduct once and then take medians. Overlap is counted once; nested `cell.compile`/`cell.aot_compile` phases are not deducted again. This is not subtraction of phase medians. Invalid capture, clocks or cell intervals leave unavailable values. Arithmetic diagnosis does not establish actual compilation removal or artifact caching.

Both adjusted metrics have complete valid coverage for all 180 reference runs. Remaining costs differ: roundtrip retains admission, policy, snapshots and communication; validated total additionally retains initialization, oracles, warmups and disposal; runtime execution excludes admission/snapshots.

| Large cold, n=5, seconds | Python/TS host | Python/Rust host | Wasm interpreter | Wasm AOT |
|---|---:|---:|---:|---:|
| N01 Roundtrip − Cargo/AOT | 5.784 | 5.792 | 17.466 | 1.208 |
| N01 Validated − Cargo/AOT | 5.931 | 5.847 | 18.135 | 1.870 |
| N03 Roundtrip − Cargo/AOT | 1.529 | 1.537 | 7.728 | 0.993 |
| N03 Validated − Cargo/AOT | 1.778 | 1.710 | 8.532 | 1.776 |
| N04 Roundtrip − Cargo/AOT | 14.221 | 14.242 | 22.921 | 1.429 |
| N04 Validated − Cargo/AOT | 14.379 | 14.350 | 23.580 | 2.107 |

## Cold and warm performance

The 180-run pilot includes cold only. Warm correctness smokes use different scales/cell counts and cannot establish cold/hot speedup. Hot corresponds to `warm` in this design.

- cold: each run starts a new workspace/runtime with no warmup. Toolchain, prepared template/vendor and OS caches remain, so this is not a machine-wide or toolchain cold start.
- warm (hot): run at least two complete workload cycles in the same workspace/runtime before measuring the last cycle. Validate every cycle. Warmups are excluded from measured cell/phase metrics but included in validated total.
- Warm conditions may reduce Cargo incremental-build, filesystem-cache or Python post-initialization costs. Rust still starts a new process/VM per cell, and AOT recompiles each time. There is no resident VM or AOT artifact reuse.
- N01's index and N03's event state reset at batch 0 of each cycle and persist only across later batches in that cycle. Warm does not skip graph index construction, reuse previous answers or reduce measured work.
- Compilation-excluded charts already remove faster compilation's benefit. Any remaining warm speedup must be measured in execution, I/O, snapshots and other phases; cold results cannot predict hot speedup.

A future campaign should pair `--cache cold,warm --warmups 2` under identical source, fixture seeds, work, cell count and acceptance. Reference source and collector have changed; do not pool new warm runs with the old cold campaign. Report total warming cost separately from post-warmup cell latency.
