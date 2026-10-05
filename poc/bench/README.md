# PoC benchmark harness (DESIGN.md §6.2–6.3)

Measures the D20 GO/NO-GO question: can models work effectively in
cell-as-program mode (group B, `rust` + WasmEdge) versus the ipython baseline
(group A), at acceptable token cost?

## Layout

```
bench/
├── run.ts        # driver: (task × model × group × rep) headless runs
├── analyze.ts    # session JSONL → per-run CSV + per-condition aggregates + D20 gate
├── launchers.ts  # agent entry-point resolution, fingerprints, and validation
├── tasks/<id>/   # task.json (prompts/turns/timeout), fixture/, check.sh
└── results/      # gitignored: plans/<planId>.json, locks/<planId>.lock, and runs/<runId>/{task,project,agent-dir,workspaces,models.json,meta.json,turn-*.log}
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

Requirements: `~/.wasmedge-agent/models.json` (or the fallback `~/.prime/agent/models.json`)
configured with your OpenAI/Anthropic-compatible
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

After all run records are registered, the driver atomically publishes a
separate `results/plans/<planId>.json` before launching the first agent.
This inventory lists every expected run ID, task, model, group, resolved
prompt variant, repetition, task/provider-config fingerprints, and agent launcher pin. Each
run's metadata links to it with `planId`. If saving the inventory fails,
no agent starts. The inventory is not rewritten as runs progress.

Each run also retains a `task/` snapshot of the selected task directory before
any agent starts. Prompts, timeout, fixture copies, and task checking all use
that snapshot, so edits to the original task during execution do not change
later runs. `taskHash` records its SHA-256 fingerprint: sorted relative paths,
directory entries, file bytes, and file executable bits; absolute paths and
timestamps are excluded. Task inputs must be regular files or directories;
symlinks and special files are unsupported. Snapshot changes detected before
run setup or around task checking become driver errors. Checkers must write
outputs to `PROJECT_DIR` or temporary storage, not into their task snapshot.
These snapshots record task inputs; they are not protected from host code
and do not pin agent binaries or external tools.

Before planning, the driver reads the seed `models.json` once and requires a
JSON object (allowing the model registry's line comments and trailing commas);
missing or malformed input stops the invocation before any run
is registered or agent starts. Every planned run retains those exact bytes
in its own `models.json`, with a SHA-256 `providerConfigHash` in `meta.json`.
The active `agent-dir/models.json` is created from that snapshot. Editing the
original seed during execution therefore does not change subsequent runs.
Both copies are checked before launch, around every turn, and around task
checking; detected changes become driver errors. Snapshots and active copies
are created with mode `0600`, inside run directories created with mode `0700`.
They may contain literal credentials and stay in the gitignored results;
metadata and CSV contain only the fingerprint, not configuration contents.

This pins file bytes, not effective provider settings. Environment references,
credential commands, provider-side routing/model aliases, agent defaults,
and external tools remain outside the fingerprint. Matching hashes also do
not prove both agent versions interpret the configuration identically.
Boundary checks do not prevent host code from modifying and restoring a file
between checks. This does not provide process or filesystem isolation.

Before registering any run, the driver resolves each selected agent launcher
to an absolute invocation path and records its symlink target and SHA-256 file
hash as `launcherPath`, `launcherRealPath`, and `launcherHash` in both the run
metadata and plan. A/B use `BENCH_PRIME_AGENT` (default `prime-agent`); F uses
the repository's `wasmedge-agent.sh`. Bare commands use the driver's current
`PATH`; relative paths and relative PATH entries resolve from the driver's
working directory. All selected launchers must be readable executable regular
files, including for `--plan-only`. Planning reads them without executing them.

Daemons and clients run the recorded absolute invocation path. The driver
checks file content, resolved target, and executable access before setup and
launch, around each turn, and before/after checking the task. A mismatch is a
driver error with no acceptance result; later turns do not start. Turn-boundary
verification overhead is included in `wallMs`.

This pins only the entry-point file, not a transitive installation. A shell
wrapper's source tree, PoC extension, packages, interpreter, template, Cargo,
WasmEdge, shared libraries, environment, and provider routing are still external
inputs. No executable version probe or full runtime snapshot is performed.
Concurrent changes between checks can escape detection; these are local
experiment records, not tamper-proof attestations.

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
plan, but no agent has run yet. Records left without their inventory block
analyzer verdicts.

### Saving and resuming a plan

```bash
# Save the full selection and snapshots without launching any agents.
node poc/bench/run.ts --groups A,F --reps 3 --models provider/model --plan-only

# Use the plan ID printed by the driver; do not pass selection overrides.
node poc/bench/run.ts --resume-plan <planId>
```

Resume executes only untouched `planned` runs from the saved inventory, in
their original order. It retains run IDs, repetition/variant assignments,
`plannedAt`, task snapshots, provider-config snapshots, and the inventory
itself. The current source tasks and seed `models.json` are not read. Before
any agent starts, every referenced record must match the plan, and every
pending run's snapshots must match their fingerprints. Missing/malformed
records, duplicate slots, mismatched paths or fields, changed pending inputs,
and `planned` records with execution artifacts or nonempty execution fields
stop the invocation without starting a run. Resume requires the original
absolute results location; it does not relocate archived sessions.
Pending launchers must also match their saved path/target/hash and remain
executable. Resume uses those saved paths, ignoring a changed
`BENCH_PRIME_AGENT` or PATH lookup for the agent entry point. It does not
override PATH for interpreters or commands invoked by a wrapper.

Completed runs are skipped, including failed task checks and timeouts.
`running` and `error` runs are also skipped, preserving all partial evidence;
they make the resumed invocation exit nonzero even if the remaining planned
runs succeed. Resume does not retry an attempted run, continue a partial
conversation, reset metadata, or stop processes left by an interrupted driver.
Incomplete observations continue to withhold analyzer verdicts.

New plans record `executionLockVersion: 1`. Both initial execution and resume
hold an exclusive `results/locks/<planId>.lock` containing the owner PID,
hostname, start time, and ownership token. This prevents cooperating drivers
from executing the same plan concurrently. Normal completion and caught errors
release the lock; forced termination can leave it behind. There is no automatic
stale-lock takeover: inspect the recorded owner and any private benchmark
processes, confirm they have stopped, then remove only that plan's stale lock
before resuming. Do not kill a process based only on a saved PID. Older plans
without the locking marker remain analyzable but cannot be resumed, because
their original executor did not participate in this lock protocol.
New plans also record `launcherPinVersion: 1`; plans without this marker remain
analyzable but cannot resume because their original launcher identity is unknown.
Completed/running/error slots retain their evidence without inspecting the
current launcher file; only pending slots can execute and require that file.

The lock and local records are not tamper-proof or a host security boundary.
Resumed runs use pinned agent entry points and task/config snapshot bytes,
but still use current wrapper dependencies, toolchains, environment, and provider
routing. Use the same external environment when continuing an experiment.

## Metrics (analyze.ts)

The analyzer checks every saved plan against the discovered run records.
Missing records (including an entire model), duplicate run IDs or planned
slots, changed slot fields, unknown plan links, and malformed plans or records
withhold **all** D20 verdicts for that results directory. It lists the problems
under `Run inventory`; readable per-run metrics and discovered-record
aggregates remain available. Missing records do not become failed tasks,
zero-token samples, or invented CSV rows. The CSV appends `planId`.

Separate driver invocations have separate inventories and may still be
compared when their task/config evidence matches. Legacy records without
`planId` retain the existing evidence checks and are counted separately;
their full inventory cannot be verified. Keep plans together with their run
records when archiving results. These local files are not tamper-proof: if a
plan and all its records disappear together, the analyzer cannot recover
them. An inventory describes the driver's selected matrix; it does not
prove the full D21 selection was requested.

Per run: pass (check.sh), wall time, tokens in/out (incl. cache), assistant
turns, tool calls by name, cell count, compile-error cell share, cell duration
p50/p95, error tool results. Token and cell-count aggregates use conventional
sample medians per (model, group[/variant]): odd samples select the middle
value; even samples average the two middle values. The D20 gate compares
each B prompt variant and the built-in fork group F with the same-model A:
treatment pass-rate ≥ A − 15pp and median output tokens ≤ 2.0 × A. A zero
baseline median permits only a zero treatment median; it does not waive the
token threshold.

The `D20 overall` summary evaluates each treatment separately: F, B/example,
and B/noexample never pool passing models. GO requires at least two distinct
model IDs to each meet **both** thresholds. Repeated runs of one model count
as one model. Once all comparisons are complete, fewer than two passing
models yields NO-GO; fewer than two recorded models yields no verdict.

For each treatment, the model set includes every model recorded in A or that
treatment. Missing counterparts and incomplete evidence withhold the overall
verdict, even if two other models pass. All models must use the same task
IDs, versions, and relative task weights; proportional repetition counts
are allowed. Per-model results and CSV metrics remain available separately.

By default, this summarizes the recorded selection, not the completeness of the full
D21 experiment: it does not require all 12 tasks, three repetitions, or the
open-weight model. Model IDs are compared literally; provider aliases and
model families are not resolved. The summary cannot recover models/runs
absent from both records and saved plans or verify effective provider settings
and toolchain versions. Latency and recovery remain reported observations,
outside the D20 pass/token gate.

### Requiring the D21 matrix

For a full-matrix audit, supply `--d21 path/to/profile.json` with the literal
model IDs used in the run metadata:

```json
{
  "version": 1,
  "models": {
    "sonnet": "provider/sonnet-model-id",
    "opus": "provider/opus-model-id",
    "openWeight": "provider/open-weight-model-id"
  },
  "treatment": "F"
}
```

```bash
node poc/bench/analyze.ts --d21 path/to/profile.json
```

The three IDs must be distinct. Roles are operator declarations: review the
provider configuration and model identities when preparing the profile.
The analyzer does not resolve aliases or verify a provider's actual routing,
model family, or open-weight status. The profile contains no credentials.

This mode requires exactly the 12 task IDs above × three declared models ×
baseline A and the selected treatment × repetitions 1, 2, 3: 216 completed,
inventory-backed runs. All discovered records participate; there is no
automatic selection of favorable runs. Archive unrelated runs **together
with their plans** outside `results/runs` and `results/plans` before auditing
a separate experiment. Multiple driver invocations may fill the matrix, but
each slot must occur exactly once across all plans. Missing tasks, models,
or repetitions are detected even if their plans are also absent. Extra slots,
duplicate slots, unplanned legacy records, incomplete driver runs, or
inconsistent inventories withhold all D20 verdicts while retaining metrics.

`treatment` accepts `F`, `B/example`, `B/noexample`, or `B/split`. F requires
the `builtin` variant and A requires `n/a`. B/split follows the driver's D17
assignment: repetitions 1 and 3 use `example`, repetition 2 uses `noexample`.
The two B variants still receive separate D20 comparisons; passing models
are never pooled across variants. A fixed B variant requires all three
repetitions to use that variant.

`D21 coverage: COMPLETE` confirms the declared matrix and completed driver
records, not performance or measurement validity. The existing D20 evidence
checks (including matching task/config hashes and complete check/output usage)
and thresholds still apply. With `--d21`, exit status is 0 only when coverage
is complete and every requested treatment variant receives overall D20 GO;
1 means missing/inconsistent evidence or NO-GO, and 2 means invalid CLI/profile
input. Without `--d21`, the existing exploratory verdicts and exit behavior
remain available. Neither mode pins agent binaries, toolchains, or effective
provider settings, or establishes statistical significance.

### Evidence and metric conventions

The summary lists distinct `tasks` separately from `runs` (discovered
records, including unstarted ones); missing planned records are listed in
the inventory report. Before applying the D20 thresholds,
each treatment condition must have the same task IDs and the same share of runs per task as its
baseline. For example, three repetitions per task in A and two per task in a
B prompt split are comparable; omitting a task or changing its relative
weight withholds the verdict. All recorded runs remain in the CSV and
summary; the analyzer does not select only the overlapping tasks. A missing
or invalid task ID makes the task count unavailable and also withholds the
verdict. Each task must also have one valid `taskHash` across all runs within
a condition, matching the same task's hash in its baseline. Missing or
malformed hashes, mixed versions within a condition, or different versions
between conditions withhold the verdict. The CSV appends `taskHash`; recorded
metrics remain visible even when versions cannot be compared. Historical
runs without fingerprints therefore retain their metrics but get no new D20
verdict. Matching task inputs does not establish statistical significance.

Each condition must also have one valid `providerConfigHash` across all its
runs, matching the same-model baseline. Missing, malformed, mixed, or
different fingerprints withhold both per-model and overall D20 verdicts,
while retaining recorded metrics. The CSV appends `providerConfigHash`;
historical records without it retain metrics but cannot receive a new verdict.
The hash covers the whole file, including whitespace and unused providers,
so even those differences conservatively prevent comparison. Different
models may use different files if each model's baseline and treatment match;
B variants are still evaluated separately. The analyzer compares recorded
fingerprints and does not resolve environment-dependent settings.

For records with launcher pins, each condition must use one consistent
invocation path, resolved target, and file hash across its runs. Baseline and
treatment launchers can differ. Mixing identities within a condition, or mixing
pinned and unpinned evidence in a comparison, withholds D20 verdicts. Malformed
pins or discrepancies between plan and run metadata invalidate the inventory.
The CSV appends `launcherHash`; paths stay in the plan and run metadata. Analysis
uses recorded identities without reading today's executable, so archived results
remain readable after uninstalling it. Legacy-only comparisons keep their prior
evidence rules and are explicitly reported as not verifying launchers. This
limitation also applies to legacy evidence checked with `--d21`.

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
Saved inventories detect missing preregistered records; these checks cannot
reconstruct unrecorded historical runs or deleted plans and their records.

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
