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

On macOS/Linux, each run starts its own daemon with `--mode daemon` and a
private `--daemon-socket`; baseline executables must support both options and
daemon protocol 7 (as in the pinned TypeScript baseline).
All turns in that run use the same socket. Socket directories are created
under `/tmp/wasmedge-bench-*` to keep Unix socket paths short even when results
live under a long path. The driver neither scans nor stops the user's shared
daemons. Daemon startup counts toward `wallMs`; task checking and daemon
shutdown do not. Historical measurements are unchanged.

The driver requests shutdown on its private socket before task checking and
also on failure, so the daemon stops its detached workers. A rejected request
or 10-second shutdown timeout falls back to signalling only the process group
it launched and records a driver error; detached workers may require manual
cleanup. Unexpected daemon exit or failed shutdown retains the private socket
directory for inspection. `daemonPid`, `daemonSocket`, and `daemon.log` record
the launched process and endpoint. Terminating the driver can
leave that daemon behind; a recorded PID alone is not proof of current process
ownership. This is benchmark process separation, not a host security sandbox.

Before launching any agent, the driver validates the full task selection and
writes one `meta.json` with `driverStatus: "planned"` for every selected
task/model/group/repetition, including the resolved B prompt variant. Run IDs
are unique even when different providers use the same model name. All plan
records must be written before execution begins. `plannedAt` records when a
slot was registered; `startedAt` stays null until that run starts.

The driver changes the record to `running` before run setup, checkpoints
completed turns, then records `completed` after task checking or
`error` with `driverError` for a caught driver failure. Updates use a temporary
file and rename so an interrupted rewrite leaves the previous JSON record.
An interrupted driver leaves `planned` records for unstarted runs and may
leave a `running` record for the active run. Setup failures
have no measured `wallMs`; otherwise wall time covers daemon startup and the
attempted agent turns, excluding fixture setup and task checking. Completed
turn exit codes, logs, and the last discovered session are retained when
later work fails.

Driver failures still allow later runs to proceed, but make the driver exit
nonzero. A completed task's failed check or timeout remains a benchmark
outcome, distinct from a driver error. Recording requires a writable results
directory. A failed or interrupted registration may leave only part of the
plan, but no agent has run yet. This does not implement resuming a plan or
detect records deleted after registration.

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

The summary lists distinct `tasks` separately from `runs` (registered
repetitions, including unstarted ones). Before applying the D20 thresholds,
each treatment condition must have the same task IDs and the same share of runs per task as its
baseline. For example, three repetitions per task in A and two per task in a
B prompt split are comparable; omitting a task or changing its relative
weight withholds the verdict. All recorded runs remain in the CSV and
summary; the analyzer does not select only the overlapping tasks. A missing
or invalid task ID makes the task count unavailable and also withholds the
verdict. Matching IDs and weights does not verify identical fixture versions
or model settings, or establish statistical significance.

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
These checks cover discovered records, including the driver's preregistered
slots; they cannot reconstruct unrecorded historical runs or deleted records.

The appended `driverStatus` CSV field distinguishes `planned`, `running`,
`completed`, `error`, `invalid` (unrecognized status), and `legacy` (field absent). Per-run
CSV observations from incomplete runs remain visible and may be partial.
The summary counts these runs under `driverIncomplete`; their condition's
performance and success aggregates are unavailable, and either condition
having one withholds the D20 verdict even if usage and checks appear complete.
Planned runs have no check, timing, or transcript measurements; they are
incomplete observations, not failed tasks or zero-token runs.
Legacy records retain the existing evidence checks for compatibility; absent
historical runs cannot be recovered from the available metadata.

Cell-duration p50/p95 retain the historical percentile convention: sort
values, select zero-based index `floor(n × p / 100)`, capped at the last index.
Thus cell p50 selects the higher middle value for even samples. Every Rust or
IPython cell result must provide a finite, nonnegative numeric `durationMs`;
zero and fractional durations are valid. A missing or invalid duration makes
latency unavailable for that run and its condition, rather than pooling only
the known durations. An empty sample is also unavailable, not 0 ms. Runs with
no cells contribute no duration samples and do not invalidate other runs'
complete samples. Per-condition cell p50 pools individual cell durations; it
is not a median of per-run p50 values. Missing timing alone does not change
other metrics or the D20 verdict.

Compile-error recovery (DESIGN §6.3) follows the ordered Rust tool results
within each run. Every `compile_error` is one sample: its distance to the
next `ok` Rust result counts subsequent Rust cells, including intervening
errors, timeouts, and aborts. Thus `compile_error, compile_error, ok` yields
distances 2 and 1 (mean 1.5). Other tools and conversation turns neither close
a recovery nor add to that distance; a success in another run cannot close it.
This measures the next observed success, not whether the same code was fixed
or the task was correct.

The CSV appends `recoveredCompileErrors`, `unrecoveredCompileErrors`, and
`compileRecoveryMeanCells`. The summary also counts runs with unrecovered
errors. Means pool recovered-error distances across runs, rather than
averaging per-run means. Errors with no later successful Rust cell are
reported separately, even if task acceptance passed. With no recovered
samples, the mean is unavailable, not zero. Missing or inconsistent Rust
statuses make recovery metrics unavailable for the run and its condition;
unusable sessions do likewise. These observations do not add a D20 gate.
Historical CSVs without ordered cell results cannot reconstruct this metric.

Before the October 2 correction, the analyzer also used that upper-middle
convention for values labeled `med`, and omitted D20 verdicts for F. Historical
reports preserve those outputs separately from corrected sample medians.

Known caveat: some gateways do not report input tokens in streaming
responses, and providers may already have normalized absent usage to zero
before saving the session. The analyzer cannot distinguish such stored zeros
from measured zeros. Historical CSVs are unchanged, and their input totals
do not establish a complete input-cost comparison. The D20 token gate uses
output tokens.
