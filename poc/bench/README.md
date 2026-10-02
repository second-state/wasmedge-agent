# PoC benchmark harness (DESIGN.md §6.2–6.3)

Measures the D20 GO/NO-GO question: can models work effectively in
cell-as-program mode (group B, `rust` + WasmEdge) versus the ipython baseline
(group A), at acceptable token cost?

## Layout

```
bench/
├── run.ts        # driver: (task × model × group × rep) headless runs
├── analyze.ts    # session JSONL → per-run CSV + per-condition aggregates + D20 gate
├── tasks/<id>/   # task.json (prompts/turns/timeout), fixture/, check.sh
└── results/      # gitignored: runs/<runId>/{project,agent-dir,workspaces,meta.json,turn-*.log}
```

## Tasks (full set, DESIGN.md appendix C)

| id | category | shape |
|---|---|---|
| 01-log-stats | text-data | count ERROR kinds in a 96-line log → report.md |
| 02-csv-normalize | text-data | messy CSV → typed users.json |
| 03-fix-bug | code-fix | planted `<` vs `<=` bug; project tests must pass |
| 04-multi-turn-state | state-reuse | turn 1 explore + persist; turn 2 answer from notes |
| 05-toolchain-loop | toolchain | two planted bugs; iterate `node --test` until green |
| 06-build-cli | build | write wordfreq.js CLI matching an exact output contract |
| 07-todo-scan | text-data | multi-file TODO/FIXME scan → todos.md, exact format |
| 08-rust-rename | code-fix | cross-file rename in a Rust crate; `cargo test` stays green |
| 09-helper-accumulation | state-reuse | 3 turns: build capability → reuse on 2nd log → combined summary |
| 10-lint-fix | toolchain | fix all `node lint.js` violations, behavior tests stay green |
| 11-join-report | build | join customers.json × orders.csv → spend.md |
| 12-repair-config | build | repair error-injected config.json against strict validator + OPS.md |

(Wave-1 measurement launched before 07–12 existed and covers 01–06; rerun with
`--tasks 07-...,...` or without `--tasks` for the full set.)

Every fixture is deterministic and every `check.sh` is offline (node + coreutils
only). Prompts are group-neutral ("the project root"): group A resolves it as
cwd, group B as /workspace.

## Running

```bash
# smoke: one task, treatment group only, 1 rep
node poc/bench/run.ts --tasks 01-log-stats --groups B --reps 1

# full wave-1, both groups, 3 reps, D17 prompt sub-A/B on group B
node poc/bench/run.ts --groups A,B --reps 3 --variant split \
  --models gateway/anthropic/claude-sonnet-4-6,gateway/anthropic/claude-opus-5

node poc/bench/analyze.ts
```

Requirements: `~/.prime/agent/models.json` configured with your OpenAI/Anthropic-compatible
provider (the API key env var it references must be set), prime-agent runnable from source
(`BENCH_PRIME_AGENT` overrides the path), and for group B the PoC extension
prerequisites (see `../README.md`). Group A bootstraps a shared kernel venv on
first run (`~/.wasmedge-agent/bench/kernel-venv`, one-time).

Isolation per run: fresh fixture copy as the project dir, fresh
`PRIME_AGENT_CODING_AGENT_DIR` (so sessions/artifacts stay inside the run dir),
fresh group-B workspace root. Multi-turn tasks use `--resume` between turns.

## Metrics (analyze.ts)

Per run: pass (check.sh), wall time, tokens in/out (incl. cache), assistant
turns, tool calls by name, cell count, compile-error cell share, cell duration
p50/p95, error tool results. Token and cell-count aggregates use conventional
sample medians per (model, group[/variant]): odd samples select the middle
value; even samples average the two middle values. The D20 gate compares
each B prompt variant and the built-in fork group F with the same-model A:
treatment pass-rate ≥ A − 15pp and median output tokens ≤ 2.0 × A. A zero
baseline median permits only a zero treatment median; it does not waive the
token threshold.

Unavailable metrics are blank in the per-run CSV and `n/a` in the summary.
The appended `sessionStatus` CSV column distinguishes `ok` (parsed, with at
least one assistant message), `missing`, `unreadable`, `invalid` (malformed
JSONL or message structure), and `empty` (no assistant messages). Unusable
sessions have no transcript-derived metrics; a valid session can still have
unknown usage. Each token total requires explicit, nonnegative safe-integer
counts on every assistant turn. Input totals include optional cache-read and
cache-write counts, which default to zero only when absent.

A condition's aggregate is unavailable if any run lacks the corresponding
evidence; the analyzer does not silently drop that run or substitute zero.
The D20 verdict requires boolean task-check results and complete output-token
totals for every run in both conditions. Missing input usage alone does not
block the output-token gate. Explicit zero counts remain valid measurements.
These checks cover discovered runs; they do not verify that all planned tasks
or repetitions were recorded.

Cell-duration p50/p95 retain the historical percentile convention: sort
values, select zero-based index `floor(n × p / 100)`, capped at the last index
(0 when no cell durations were recorded). Thus cell p50 selects the higher
middle value for even samples. Per-condition cell p50 pools individual cell
durations; it is not a median of per-run p50 values.

Before the October 2 correction, the analyzer also used that upper-middle
convention for values labeled `med`, and omitted D20 verdicts for F. Historical
reports preserve those outputs separately from corrected sample medians.

Known caveat: some gateways do not report input tokens in streaming
responses, and providers may already have normalized absent usage to zero
before saving the session. The analyzer cannot distinguish such stored zeros
from measured zeros. Historical CSVs are unchanged, and their input totals
do not establish a complete input-cost comparison. The D20 token gate uses
output tokens.
