# Opus 5.5: Rust cell workload end-to-end validation

Date: 2026-10-10. The existing [180-run fixed-program results](benchmark-rust-cell-workloads-2026-10-10.html) are preserved. The new `workloads-e2e` suite asks the same model to read fixtures, generate Python/Rust cells, execute them and repair errors. No solution source is supplied, and numeric packages are excluded. Existing independent oracles validate every output element and input integrity.

**Status: the 12-run smoke and 36-run large/cold pilot both passed completely. All 164 real model requests returned HTTP 200, complete streams and usage; SSE identified `claude-opus-5-5`.** [Large pilot charts and comparison](benchmark-rust-cell-e2e-2026-10-10.html) · [Smoke report](benchmark-rust-cell-e2e-smoke-2026-10-10.html). Two earlier HTTP 500 campaigns remain infrastructure evidence and are excluded from successful timings.

Compare `prime-ts`, `prime-rust`, `wasmedge` and `wasmedge-aot`. The smoke covers three small tasks across four variants, totaling 12 runs. The pilot fixes large/cold/binary/PRNG/one workload batch with three repetitions, totaling 36 runs. The model chooses a reasonable cell count. Variants retain native product prompts and use runtime-cell tools only, with no shell/subprocess delegation and reasoning off.

## What do the three tasks measure?

Fixed-program and E2E tests share specifications and fixtures. In E2E, the model writes, executes and repairs its own solution. Work below is the total per run; batching does not multiply it.

| Task | Small smoke | Large pilot | Typical purpose and required work |
|---|---|---|---|
| N01 graph | 1,000 nodes, 4,000 edges, 64 queries | 100,000 nodes, 400,000 edges, 256 queries | Dependency change impact: build reverse adjacency, then BFS separately for each query |
| N03 events | 100,000 events, 10 keys | 10,000,000 events, 1,000 keys | Transaction/session events: stream decoding, deduplication, timeouts and state transitions |
| N04 simulation | 10,000 trajectories × 256 steps, 2.56 million updates | 1,000,000 trajectories × 256 steps, 256 million updates | Bounded work queues: u32 PRNG, branches and step-by-step state updates |

**N01 graph: dependency change impact.** An edge in `graph.bin` means component A depends on component B. A query for B finds B and every component that directly or indirectly depends on it, such as targets needing a rebuild. Build reverse adjacency once, then run BFS independently for every root, correctly handling cycles and repeated edges. Cached answers or component-level shortcuts cannot replace traversal. Output one bitmap per query; the checker compares every bit. This measures graph index access, integer conditions and bitmap updates.

**N03 events: streaming transaction state machine.** Each input record contains timestamp, key, sequence, amount and a START/CHARGE/COMMIT/CANCEL kind. Maintain independent state per key: deduplicate by sequence first, handle timeouts beyond 30,000 time units next, then apply charges, commits or cancellations. Negative charges and illegal transitions count as invalid. Read in order with bounded chunks and retain state across batches. Large binary input occupies 320,000,000 bytes; the task includes I/O and decoding. Output each key's final state, amounts and six statistics; the checker compares every field.

**N04 simulation: integer queue trajectories.** Each u32 seed starts an independent trajectory with queue capacity 64. At every step, update `x = (1664525*x + 1013904223) mod 2^32` and use its high two bits to choose enqueue, completion or expiry. Record rejection when the queue is full. Every trajectory must execute all 256 steps; formulas or cached answers cannot skip work. Output four u32 values per trajectory: `[final queue length, completed, expired, rejected]`. The checker compares every value. This measures wrapping integer arithmetic and loops with frequent branches.

All three tasks use standard libraries, with no NumPy comparison. Oracles compute expected results independently outside the agent project and check complete outputs and input hashes. A success marker alone is insufficient. HTML reports present tasks, actual campaign dimensions, inputs, required work and validation before the charts.

## Large/cold results

Each group has three repetitions. The table reports successful-run medians in seconds. Both adjustments are calculated per run before taking medians. The new [E2E minus Cargo/AOT, excluding model chart](benchmark-rust-cell-e2e-2026-10-10.html#validatedWithoutCompilationAndModelMs) counts overlapping compiler/model intervals once. LLM, compiler and cell intervals can overlap, so columns are not additive.

| Work | Variant | Passed/planned | E2E total | E2E minus Cargo/AOT | E2E minus Cargo/AOT/model | Runtime execution | LLM request sum |
|---|---|---:|---:|---:|---:|---:|---:|
| graph | prime-ts | 3/3 | 20.949 | 20.949 | 7.760 | 5.617 | 13.188 |
| graph | prime-rust | 3/3 | 22.869 | 22.869 | 5.703 | 5.570 | 17.166 |
| graph | wasmedge | 3/3 | 33.838 | 29.285 | 17.475 | 16.314 | 14.743 |
| graph | wasmedge-aot | 3/3 | 21.723 | 14.136 | 1.965 | 0.426 | 13.521 |
| events | prime-ts | 3/3 | 20.738 | 20.738 | 3.844 | 1.453 | 17.669 |
| events | prime-rust | 3/3 | 15.009 | 15.009 | 1.644 | 1.415 | 13.378 |
| events | wasmedge | 3/3 | 41.442 | 36.859 | 22.615 | 21.348 | 15.760 |
| events | wasmedge-aot | 3/3 | 32.960 | 24.736 | 2.108 | 0.418 | 24.819 |
| simulation | prime-ts | 3/3 | 29.970 | 29.970 | 16.732 | 14.228 | 13.219 |
| simulation | prime-rust | 3/3 | 27.875 | 27.875 | 13.580 | 13.445 | 15.220 |
| simulation | wasmedge | 3/3 | 38.598 | 33.979 | 24.795 | 23.640 | 10.861 |
| simulation | wasmedge-aot | 3/3 | 20.568 | 12.744 | 2.703 | 1.168 | 12.276 |

For N04 integer simulation, AOT's median paired complete-E2E speedup is **1.458× versus prime-ts and 1.336× versus prime-rust**. Excluding Cargo/AOT, those ratios are 2.269× and 2.079×. Runtime-execution ratios are 12.187× and 11.635×, retaining file reads, VM/bridge work and inspection cells; they are not fixed-program language ratios. For each matched workload/seed/repetition, divide baseline duration by AOT duration, then take the median of the three ratios. Above 1 means AOT was faster. This differs from dividing group medians.

Graph AOT runtime is much shorter, but complete-E2E paired ratios are only 0.879× versus prime-ts and 1.053× versus prime-rust. Events AOT runtime ratios are 4.158×/3.389×, while complete-E2E ratios are 0.627×/0.507×: generation, extra calls and compilation repairs offset execution gains. The interpreter beats neither Python baseline in complete E2E or compilation-excluded E2E for any of these tasks. **AOT integer simulation carries the clearest benefit through real E2E in this pilot; the results do not establish that all Rust cells are faster.**

Large passed 36/36 with zero timeouts. All 127 requests have a complete message-stop, expected model ID and usage: 1,619,171 input / 50,292 output tokens, with cached input included. The 91 cell calls include two compilation failures repaired by the model; failed-build costs remain. Every metric has n=3 per group. This is descriptive, without formal confidence intervals or ranking. All nine workload/repetition fixture groups have identical input/expected hashes across variants and match the first three repetitions of the preserved fixed-program pilot.

[Portable aggregate data](bench-data/workloads-e2e-pilot-2026-10-10.json) contains per-run timings, paired ratios, fixture hashes and a 127-request ledger with message IDs/usage. The [smoke aggregate](bench-data/workloads-e2e-smoke-2026-10-10.json) retains its separate 37-request ledger. Neither contains the provider URL or API key. Original requests, SSE and generated sources remain in ignored results in the main workspace; aggregates do not replace them.

## Model requests and data preservation

Read only the two user-specified provider exports without modifying `~/.zshrc`. Credentials remain in the gateway; children receive a local token with no paid-provider authority. The original endpoint catalog listed `anthropic/claude-opus-5-5`, while successful short-request SSE returned `claude-opus-5.5`. This is service-advertised identity, without independent verification of an immutable backend revision.

The replacement Claude Platform service exposed the model ID through `GET /v1/models`, x-api-key and anthropic-version, using the native [Models API protocol](https://platform.claude.com/docs/en/api/models/list). Products use the Anthropic Messages provider directly. The local gateway forwards `/v1/messages` and original SSE without translating to OpenAI wire format. Each request retains message-start model/message IDs, message-stop and native usage. Input totals include uncached, cache-creation and cache-read tokens; output uses final cumulative usage, without adding start and end usage twice.

Smoke passed 12/12. All 37 requests have usage: 458,875 input / 13,875 output tokens, including cached input. Its 25 runtime-cell calls include one compilation failure repaired by the model. Repairs, requests and failed builds remain timed. Small groups have one run each and validate the full workflow and measurement coverage only.

The old OpenAI-compatible service exposed a model catalog at its root but required `/v1/chat/completions` for completions. The first smoke's ten nginx HTTP 500 responses, zero model output and interruption record remain saved; a new campaign was created rather than replacing the failed attempt. Three endpoint probes also retain requests, responses and usage separately from benchmark results.

After correcting `/v1`, the second smoke's full agent payload still received eleven nginx 500 responses. Both campaigns stopped in their first slot, retaining original `running` results and separate `interruption.json` records. They are incomplete/infrastructure evidence, not performance samples or product correctness failures. Remaining slots were unexecuted.

Non-generating body-size probes used the same JSON payload without model/messages:

| Request body bytes | HTTP | Response |
|---:|---:|---|
| 1,043 | 400 | Normal JSON field-validation error |
| 8,211 | 400 | Normal JSON field-validation error |
| 16,403 | 500 | nginx HTML error |
| 32,787 | 500 | nginx HTML error |

The full agent request was approximately 26,492 bytes. Removing optional fields, collapsing text-content arrays and removing tool strict fields still returned 500. A simple tool request generated `benchmark_probe` successfully, with 387 input / 62 output tokens. A text probe used 25 input / 14 output tokens. Both returned `claude-opus-5.5`, but validated connectivity/tool protocol only, without executing a benchmark task.

Gzip reduced a 32 KB JSON payload to 91 wire bytes; the old service returned 400 `Invalid JSON`, indicating no support for that request encoding. The relationship between larger bodies and nginx 500 was reproduced; the specific buffering, temporary-directory, permission or disk cause requires service-side logs. Full native agent requests succeeded on the replacement Claude Platform endpoint, without shortening the product system prompt.

Four original campaigns were copied to `poc/bench/results/workloads-preserved-20261010/` in the main workspace, including fixtures, outputs, compiler artifacts and traces. SHA-256 checks matched 882 manifest/prepared/environment/result/event/span files. Backup `preservation.json` records original paths and hashes. New E2E campaigns reside directly in the main workspace's `poc/bench/results/`, retaining request bodies, SSE, status, model/completion IDs, usage, tool arguments, sources, sessions, cell traces and checker results.

## Reproduction

Prepare pinned versions/toolchains using the [runner instructions](../poc/bench/three-way/README.en.md), then run with the exported credentials:

```sh
npx tsx poc/bench/three-way/cli.ts discover --api anthropic-messages --model claude-opus-5-5
npx tsx poc/bench/three-way/cli.ts plan --suite workloads-e2e --scales small --reps 1 --seed 20261010 --provider poc/bench/results/three-way-provider.json --out poc/bench/results/workloads-e2e-smoke
npx tsx poc/bench/three-way/cli.ts run --plan poc/bench/results/workloads-e2e-smoke
npx tsx poc/bench/three-way/cli.ts analyze --plan poc/bench/results/workloads-e2e-smoke
npx tsx poc/bench/three-way/cli.ts plan --suite workloads-e2e --scales large --reps 3 --seed 20261010 --provider poc/bench/results/three-way-provider.json --out poc/bench/results/workloads-e2e-pilot
npx tsx poc/bench/three-way/cli.ts run --plan poc/bench/results/workloads-e2e-pilot
npx tsx poc/bench/three-way/cli.ts analyze --plan poc/bench/results/workloads-e2e-pilot
```

`--batches 4` tests state/helper reuse across turns; this pilot uses b1. E2E warm policy is undefined: previously generated code is not a hot-agent result. Each run permits at most 64 requests and a 600-second b1 deadline, including retries.

## Timing boundaries and comparison limits

E2E validated total starts before daemon startup and ends after the external checker. It includes model wait/generation, all cells, repairs, Cargo/AOT, snapshots and final replies. Fixture/oracle generation and teardown are excluded. Offline validated timing differs around runtime disposal; subtracting offline totals from E2E does not measure model time.

The compilation-excluded E2E chart merges calibrated Cargo/AOT intervals per run, clips them to validated time and deducts once before taking medians. It retains model time and is an arithmetic diagnostic, not a run omitting compilation. Runtime execution directly sums product execution durations across cells, including I/O/process/VM work and excluding compilation.

The model-excluded chart uses `per-run validated elapsed − union(Cargo commands, AOT commands, LLM requests)`. Every interval must have complete endpoints, a unique identity and the same collector clock, and is clipped to validated time. Missing necessary evidence yields unavailable, never zero. Compiler/model overlap occurs in 18/36 large runs and 6/12 smoke runs. Subtracting `Cargo + AOT + LLM sum` would deduct overlap twice. JSON retains the model union, combined deduction, overlap and unavailable reasons for per-run verification.

“Excludes model” removes the gateway-receipt-to-stream-end wall-time windows. Host startup/dispatch, runtime/I/O, snapshots, the external checker and request gaps remain. If a cell overlaps model streaming, that cell wall-time segment is also removed; complete cell execution is reported separately. This is residual wall time from existing E2E, not a new model-free experiment or pure algorithm compute. Code emission/code ready are already inside model intervals and must not be subtracted again. Column medians cannot be subtracted to obtain this metric.

LLM request time sums gateway receipt through stream end, including errors/retries. Code emission covers the source field's first-to-last SSE event; code ready covers receipt to the final source event. Both are inside LLM time and are not additive. Tokens come from service usage; any missing request usage leaves totals unavailable.

Large fixtures match the preserved fixed-program pilot's first three repetitions in seed derivation, dimensions and verified input/expected hashes. Generated implementations, I/O, layouts and cell counts may differ. E2E execution ratios are not fixed-program language performance. Failed/timed-out/missing slots remain, while timings use successful medians. Three repetitions are descriptive, without formal confidence intervals, a collector-overhead audit or ranking.

## Validation

`npm run check` passed. Both modified benchmark test files passed 62 tests using mock providers, without paid API calls. The root report checker now includes these workload readers and chart anchors; all 193 local links and ten link-checker regression tests passed. Desktop 1440 px and mobile 390 px were visually checked in an isolated browser: five E2E charts with 60 bars and 24 table rows, no page-level horizontal overflow, and dedicated chart/table scroll containers. The browser and benchmark daemons were closed.

All 116 generated tool-source records were screened without finding the listed numeric/native-extension imports or shell APIs. All 48 run cell contracts were compliant; first-repetition loops for all three tasks were also inspected manually. Large cells had zero runtime failures; both compile-failure costs remain. Source screening uses the runner's recognizable API rules, while independent full-output oracles establish correctness.

The English export was generated from retained results without new model requests. Original numeric metrics, fixture pairing and request ledgers remain unchanged.
