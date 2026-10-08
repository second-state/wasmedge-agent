# Prime Agent vs WasmEdge Agent benchmark — 2026-08-10

## Executive summary

A 144-run campaign compared stock Prime Agent's IPython runtime (A), pinned at the revision below, with this fork's built-in Rust/WasmEdge runtime (F): **12 distinct tasks × two models × three repetitions × two groups**. Each group has 72 runs, not 72 distinct tasks. These are August 10 revisions, not the current upstream or fork.

- F passed **72/72 (100%)**; A passed **69/72 (95.8%)**.
- F's overall median wall time was **33.47s**, versus **19.12s** for A: **1.75×**.
- On per-model medians, F was **1.98×** A for Opus 5 and **1.74×** A for Sonnet 4.6.
- F used **1.76×** A's reported output-token p50 on Opus and **1.55×** on Sonnet (the historical analyzer used an upper-middle convention; see §3.1).
- F used fewer model-facing cells (median 2 versus A's 3–4), but its cell p50 was about **15–16×** A's IPython cell p50.
- F passed the recorded D20 acceptance gate for both models: pass rate was at least A minus 15 percentage points and the analyzer's output-token p50 stayed below 2.0× A.

All three baseline failures were Sonnet repetitions of `08-rust-rename`; Opus passed all runs in both groups. The result is a sample-specific pass-count difference with higher time and output-token usage. Language, tool semantics, prompts, and execution environment changed together, so the difference cannot be attributed to the Rust compiler alone. The data do not establish that extra time or tokens caused improved correctness.

## 1. Compared revisions and environment

| Item | Value |
|---|---|
| Campaign window | 2026-08-10 15:58:17Z–17:41:18Z |
| Upstream A | `PrimeIntellect-ai/prime-agent` clean detached worktree at `c22549a37b73cc603c6f0d202517cb0ca856c7d3` |
| Fork F | local `main` at `ceea1cdcfdbd16c72cc728fb722be6dc40ddbaf4` |
| A runtime | stock built-in IPython tool |
| F runtime | built-in Rust cells compiled to `wasm32-wasip1` and run in WasmEdge |
| Host harness | TypeScript in both pinned revisions; the fork adapts tool registration, session wiring, prompts, and persistence |
| WasmEdge | 0.14.1, repository-local `.wasmedge/` installation |
| Rust | rustc/cargo 1.97.0; `wasm32-wasip1` installed |
| Node.js | 24.13.1 |
| Bun | 1.2.21 (not part of measured agent execution) |
| Host | macOS arm64 |
| Models | `gateway/anthropic/claude-sonnet-4-6`, `gateway/anthropic/claude-opus-5` |
| Repetitions | 3 per task/group/model combination |
| Raw campaign size | 144 runs, about 20 GB locally |
| Timeouts | 0 |

A used a separate clean worktree so the sibling checkout's uncommitted `packages/ai/src/models.generated.ts` change could not affect the baseline. F ran from this repository's merged `main`. Both groups used the same user `models.json`, provider endpoint, task fixtures, prompts, offline checks, serial scheduler, and per-run isolated agent directory.

Here, shared prompts means the benchmark's task prompts; the agents' system prompts and tool instructions differ. The baseline's [package manifest at the pinned revision](https://github.com/PrimeIntellect-ai/prime-agent/blob/c22549a37b73cc603c6f0d202517cb0ca856c7d3/packages/coding-agent/package.json) identifies its TypeScript build and IPython-backed CLI. Host implementation language and model-generated cell language are separate dimensions.

## 2. Command and isolation

The campaign was launched from this repository with:

```bash
WASMEDGE_AGENT_WASMEDGE="$PWD/.wasmedge/bin/wasmedge" \
BENCH_PRIME_AGENT=/Users/hydai/workspace/ss/prime-agent-clean-bench/prime-agent.sh \
node poc/bench/run.ts \
  --groups A,F \
  --reps 3 \
  --models gateway/anthropic/claude-sonnet-4-6,gateway/anthropic/claude-opus-5

node poc/bench/analyze.ts
```

The harness ran serially because all runs share a per-user daemon socket. Each run received a fresh fixture copy, a fresh `PRIME_AGENT_CODING_AGENT_DIR`, and its task's offline `check.sh`. Multi-turn tasks resumed the same session explicitly.

Before the campaign:

- 218 older M1/M5 and development runs (about 31 GB) were moved out of `poc/bench/results/` so the analyzer could not mix them with this campaign.
- A two-run smoke using an incorrectly unprefixed model name failed before model invocation and was archived separately; it is not in the results.
- A second two-run A/F smoke with the full gateway model name passed and was also archived separately.
- The final `poc/bench/results/` directory contained exactly the 144 formal runs.

## 3. Aggregate results

### 3.1 Analyzer output

| Model | Group | Runs | Pass | Output tokens p50 | Input tokens p50 | Cells p50 | Compile-error share | Cell p50 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Opus 5 | A | 36 | 100% | 443 | 0* | 3 | 0% | 15ms |
| Opus 5 | F | 36 | 100% | 781 | 0* | 2 | 23% | 226ms |
| Sonnet 4.6 | A | 36 | 91.7% | 781 | 0* | 4 | 0% | 13ms |
| Sonnet 4.6 | F | 36 | 100% | 1,213 | 0* | 2 | 33% | 212ms |

`0*` means unavailable: the gateway's streaming responses did not provide input-token usage.

**Statistic definition (corrected 2026-10-02):** the historical analyzer sorted values and selected index `floor(n × p / 100)` (zero-based). Its function named `median` called this p50 operation: for an even sample it selected the higher middle value, rather than averaging the two middle values. The table preserves the historical analyzer output and gate inputs. The [current analyzer](../../poc/bench/analyze.ts) averages the middle pair for token and cell-count medians; cell-duration p50/p95 retain the historical convention. Cell p50 pools individual cell durations from transcripts; it cannot be reconstructed from the CSV's per-run p50 values alone.

The conventional sample medians below are recomputed from the unchanged [144-row CSV](../benchmark-comparison-2026-08-10.csv). Wall-time medians in §3.2 already use this definition. Per-task medians use three repetitions, so the definitions agree there.

| Model | A output-token median | F output-token median | F/A |
|---|---:|---:|---:|
| Opus 5 | 427.5 | 755.5 | 1.77× |
| Sonnet 4.6 | 767.5 | 1,186 | 1.55× |

These corrected labels and additional statistics do not change the raw runs or the historical GO decision; both conventional median ratios also remain below 2.0×.

### 3.2 Wall-clock distribution

| Model | Group | Median | Mean | p95 | Total over 36 runs |
|---|---|---:|---:|---:|---:|
| Opus 5 | A | 14.20s | 18.84s | 43.79s | 678.07s |
| Opus 5 | F | 28.09s | 30.50s | 65.97s | 1,098.01s |
| Sonnet 4.6 | A | 21.69s | 23.31s | 46.81s | 839.20s |
| Sonnet 4.6 | F | 37.77s | 38.02s | 55.48s | 1,368.55s |
| **Both models** | **A** | **19.12s** | **21.07s** | — | **1,517.26s** |
| **Both models** | **F** | **33.47s** | **34.26s** | — | **2,466.56s** |

Ratios:

| Metric | Opus F/A | Sonnet F/A | Overall F/A |
|---|---:|---:|---:|
| Median wall time | 1.98× | 1.74× | 1.75× |
| Mean wall time | 1.62× | 1.63× | 1.63× |
| Output-token p50 (historical analyzer) | 1.76× | 1.55× | — |
| Cell p50 | 15.1× | 16.3× | — |

The sum of measured run wall times was 3,983.82s. The campaign occupied about 103 minutes of wall-clock time because the driver also settles and tears down the shared daemon between runs.

### 3.3 Interaction shape

| Model | Group | Assistant turns median | Cells median | Cells total | Compile-error cells | Error tool results |
|---|---|---:|---:|---:|---:|---:|
| Opus 5 | A | 4 | 3 | 124 | 0 | 0 |
| Opus 5 | F | 6 | 2 | 97 | 22 | 26 |
| Sonnet 4.6 | A | 5 | 4 | 133 | 0 | 0 |
| Sonnet 4.6 | F | 7 | 2 | 93 | 31 | 35 |

F issued fewer cells but needed more assistant turns. Rust compiler diagnostics are part of its intended feedback loop: 53 of 190 Rust cells were compile-error cells, after which the model repaired the program. A's Python cells had no comparable compile phase.

## 4. Per-task results

Each table entry is the median of three repetitions. `Pass` is the number of offline checks passed out of three.

### 4.1 Opus 5

| Task | A pass | F pass | A wall | F wall | Wall F/A | A tokens | F tokens | Token F/A |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 01-log-stats | 3/3 | 3/3 | 11.99s | 20.60s | 1.72× | 377 | 725 | 1.92× |
| 02-csv-normalize | 3/3 | 3/3 | 10.63s | 21.94s | 2.06× | 309 | 485 | 1.57× |
| 03-fix-bug | 3/3 | 3/3 | 13.78s | 20.89s | 1.52× | 404 | 421 | 1.04× |
| 04-multi-turn-state | 3/3 | 3/3 | 26.49s | 43.46s | 1.64× | 1,087 | 1,284 | 1.18× |
| 05-toolchain-loop | 3/3 | 3/3 | 17.44s | 29.35s | 1.68× | 605 | 971 | 1.60× |
| 06-build-cli | 3/3 | 3/3 | 20.87s | 45.43s | 2.18× | 759 | 1,473 | 1.94× |
| 07-todo-scan | 3/3 | 3/3 | 13.82s | 28.00s | 2.03× | 453 | 1,343 | 2.96× |
| 08-rust-rename | 3/3 | 3/3 | 13.67s | 31.57s | 2.31× | 359 | 664 | 1.85× |
| 09-helper-accumulation | 3/3 | 3/3 | 43.79s | 65.97s | 1.51× | 1,342 | 1,847 | 1.38× |
| 10-lint-fix | 3/3 | 3/3 | 28.48s | 33.85s | 1.19× | 1,257 | 1,026 | 0.82× |
| 11-join-report | 3/3 | 3/3 | 10.27s | 17.88s | 1.74× | 303 | 382 | 1.26× |
| 12-repair-config | 3/3 | 3/3 | 11.97s | 19.51s | 1.63× | 249 | 320 | 1.29× |

### 4.2 Sonnet 4.6

| Task | A pass | F pass | A wall | F wall | Wall F/A | A tokens | F tokens | Token F/A |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 01-log-stats | 3/3 | 3/3 | 9.91s | 17.60s | 1.78× | 263 | 396 | 1.51× |
| 02-csv-normalize | 3/3 | 3/3 | 20.63s | 21.41s | 1.04× | 784 | 573 | 0.73× |
| 03-fix-bug | 3/3 | 3/3 | 20.14s | 41.51s | 2.06× | 618 | 1,154 | 1.87× |
| 04-multi-turn-state | 3/3 | 3/3 | 29.77s | 46.69s | 1.57× | 1,095 | 1,704 | 1.56× |
| 05-toolchain-loop | 3/3 | 3/3 | 26.00s | 46.49s | 1.79× | 969 | 1,705 | 1.76× |
| 06-build-cli | 3/3 | 3/3 | 32.06s | 40.83s | 1.27× | 1,204 | 1,295 | 1.08× |
| 07-todo-scan | 3/3 | 3/3 | 11.06s | 46.83s | 4.23× | 367 | 2,914 | 7.94× |
| 08-rust-rename | 0/3 | 3/3 | 16.78s | 36.20s | 2.16× | 476 | 897 | 1.88× |
| 09-helper-accumulation | 3/3 | 3/3 | 36.09s | 49.27s | 1.37× | 1,016 | 1,540 | 1.52× |
| 10-lint-fix | 3/3 | 3/3 | 26.24s | 48.62s | 1.85× | 1,027 | 1,694 | 1.65× |
| 11-join-report | 3/3 | 3/3 | 14.35s | 32.39s | 2.26× | 456 | 1,293 | 2.84× |
| 12-repair-config | 3/3 | 3/3 | 21.81s | 32.44s | 1.49× | 672 | 960 | 1.43× |

The largest outlier was Sonnet on `07-todo-scan`: F used 4.23× the wall time and 7.94× the output tokens. This task is the clearest target for prompt/runtime-loop profiling. Conversely, Sonnet F nearly matched A's wall time and used fewer tokens on `02-csv-normalize`; Opus F also used fewer tokens on `10-lint-fix`.

## 5. Failure analysis

All three formal failures were repetitions of the same task/model/group combination:

```text
08-rust-rename | A | gateway/anthropic/claude-sonnet-4-6 | reps 1–3
```

The agent process exited zero each time in 16.1–17.9s and did not time out. Each transcript contained three IPython calls, but the project remained unchanged. The offline check found `calc_total` in:

```text
src/lib.rs
src/report.rs
tests/integration.rs
```

and reported `old name still present`. Thus these are model/task failures, not daemon, provider, timeout, or checker failures. F passed all three equivalent runs.

No run in either group timed out. No F run failed its offline check.

## 6. Acceptance gate

D20 requires, per model:

1. pass rate at least A minus 15 percentage points;
2. output-token p50 no more than 2.0× A (the analyzer convention used for this campaign; §3.1);
3. both models pass.

| Model | Pass comparison | Token comparison | Verdict |
|---|---|---|---|
| Opus 5 | F 100% vs A 100% | 781 / 443 = 1.76× | PASS |
| Sonnet 4.6 | F 100% vs A 91.7% | 1,213 / 781 = 1.55× | PASS |

**Campaign verdict: GO.**

These are the report's historical comparisons. The analyzer previously printed D20 verdicts only for the PoC group B; it now also evaluates the built-in fork group F, using conventional sample medians. Both models still meet the token threshold with the corrected medians in §3.1.

Compared with the 2026-08-07 M5 report, F retained 100% pass rate. Its Sonnet output-token ratio against A moved from 1.99× to 1.55×, creating more headroom under the 2.0× ceiling. Absolute comparisons across campaigns remain approximate because model service behavior and upstream revision can change.

## 7. Interpretation and next work

1. **Observed task outcomes:** F passed 72/72 runs versus A's 69/72 over 12 distinct tasks. The entire pass-count difference was Sonnet on one rename task; both Opus groups passed 36/36. This is not evidence of a general correctness improvement or a compiler-only effect.
2. **End-to-end latency:** F's mean wall time was 1.63× A for both models. This is the primary user-visible performance cost.
3. **Cell latency:** F's measured cell p50 was about 15–16× A's. F cells include compilation and WasmEdge startup, and the groups perform different work per cell. These measurements do not isolate VM speed or provide a full breakdown of the end-to-end time difference.
4. **Token cost:** F used more assistant turns and 1.55–1.76× the historical output-token p50 (or 1.55–1.77× conventional medians). The gap varies by task. The report does not measure how much extra time was spent reading compiler diagnostics.
5. **Priority investigation:** profile Sonnet `07-todo-scan`, then `11-join-report`; inspect why the agent emits extra code/repair turns and whether system-prompt guidance or helper APIs can shorten the loop.
6. **Secondary optimization:** reduce cold Rust-cell startup/compile cost. Even a 100–150ms reduction per cell will not erase model latency, but it improves interactive feedback and tool-heavy tasks.

## 8. Reproducibility and retained artifacts

Committed alongside this report:

- `docs/benchmark-comparison-2026-08-10.csv` — the 144-row analyzer output, SHA-256 `0f18e5078a8cebba639612a65fe911ea99e0bf3e635637d99bb571c773ab7230`.

Retained locally but intentionally not committed:

- `poc/bench/results/runs/` — raw formal transcripts and fixtures (about 20 GB).
- `poc/bench/results/full-campaign.log` — serial driver log.
- `poc/bench/results-pre-comparison-20260810/` — 218 older runs (about 31 GB).
- `poc/bench/results-smoke-invalid-model-20260810/` — two pre-model configuration failures.
- `poc/bench/results-smoke-valid-20260810/` — the successful two-run smoke.
- `.wasmedge/` — local WasmEdge 0.14.1 installation.

The CSV is regenerable from the raw formal runs with `node poc/bench/analyze.ts`. Raw runs are excluded from Git because of their size and because transcripts may contain provider/model interaction data.

## 9. Limitations

- There are 12 distinct tasks; repeated runs of the same task/model are not 72 independent task types per group. Three repetitions do not establish broad reliability or eliminate hosted-model variance.
- The provider omitted streamed input-token usage and complete monetary cost, so this report compares output tokens rather than total billed tokens or currency.
- Language, tool semantics, system prompts, and execution environment change together; there is no ablation isolating the compiler's contribution. The result measures end-to-end task completion, not isolated VM throughput.
- Wall time includes model latency, daemon/session work, compilation, tool execution, and retries. Cell p50 isolates only model-facing cell tool duration.
- The campaign ran on one macOS arm64 host and one provider endpoint; it is not a cross-platform runtime microbenchmark.
- The benchmark's serial execution avoids daemon-socket interference but makes the campaign sensitive to service conditions over its 103-minute window.
- The August 6 PoC's recovery-cell counts and WasmEdge 0.17.1 feasibility microbenchmark are separate measurements. This campaign used WasmEdge 0.14.1 and predates the October runtime fixes; it does not measure their performance or effectiveness.
