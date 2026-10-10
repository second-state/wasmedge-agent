# Four-Way Agent Benchmark Runner

For report selection and timing definitions, start with the [English documentation guide](../../../docs/README.md). This file covers running and analyzing the benchmarks.

Use `--suite workloads-e2e` or `E-N01-graph,E-N03-events,E-N04-simulation` for model-generated versions of the new workloads. No reference solution is supplied. Independent checkers validate all outputs and input integrity. Numeric packages are excluded. E2E currently supports cold workspaces only; warm is rejected until a model warmup policy is defined. Analysis adds `workloads-e2e.html/json`, separate from preserved fixed-program results. See the [Opus E2E record](../../../docs/benchmark-rust-cell-e2e-2026-10-10.md).

Workload readers, task explanations and column definitions are in English. E2E includes five charts: full validated time, minus Cargo/AOT, minus Cargo/AOT and model requests, model request sum, and runtime execution. Deductions merge verified intervals per run before taking medians, so compiler/model overlap is counted once. The model-excluded remainder retains host, I/O, snapshots and validation; it is not a model-free rerun or pure compute. Analyze reuses saved traces without making model requests.

For Claude Platform use `discover --api anthropic-messages --model claude-opus-5-5` with the service root base URL (a trailing `/v1` is accepted; omit `/messages`). Native Messages requests and SSE are forwarded unchanged using x-api-key authentication. Original usage is retained; input totals include uncached, cache creation and cache read tokens. Default OpenAI-compatible discovery prefers `/v1`, then `/api/v1`, then the original base. A working root model catalog does not prove the root completion endpoint works. Requests retain HTTP status, SSE model/completion IDs and usage. These are service-advertised identity evidence, not independent backend revision verification.

Compare `prime-ts`, `prime-rust`, `wasmedge` (interpreter), and `wasmedge-aot`. The model route is `anthropic/claude-opus-5-5`, with reasoning off. This ID comes from the service catalog. An immutable backend revision is not independently verified. The older A/B/F harness and D20/D21 rules remain separate.

For architecture, safety tests and earlier experiments, see the [October 8 English safety and performance report](../../../docs/rust-cell-report-2026-10-08.en.html), also available as [Markdown](../../../docs/rust-cell-report-2026-10-08.en.md). It predates the October 10 workload campaigns and covers fixed programs, Opus tasks, Cargo, AOT, and the bridge.

[Standalone English report](../../../docs/rust-cell-report-2026-10-08.en.html). Download that one HTML file and open it locally. It includes conclusions, charts, key tables, and timing definitions. No ZIP or other files are required.

## Requirements and commands

Use Node 22.8+, npm, Cargo, rustup with `wasm32-wasip1`, uv, and WasmEdge 0.14.1 with interpreter/AOT support. Install WasmEdge using the project instructions, or set `WASMEDGE_AGENT_WASMEDGE`. Rust hosts and adapters build with `--release --locked`.

Prepare downloads pinned source archives, builds Node bundles, creates upstream runtime environments, and vendors/warms an isolated WASI template. Inputs, bootstrap logs, and paid output remain under gitignored `poc/bench/results/`. User agent settings are not changed.

```sh
npm run build
npx tsx poc/bench/three-way/cli.ts prepare
# Use the exported credentials; source ~/.zshrc first if needed.
npx tsx poc/bench/three-way/cli.ts discover --model anthropic/claude-opus-5-5
npx tsx poc/bench/three-way/cli.ts plan --suite smoke --provider poc/bench/results/three-way-provider.json --out poc/bench/results/three-way-smoke
npx tsx poc/bench/three-way/cli.ts run --plan poc/bench/results/three-way-smoke
npx tsx poc/bench/three-way/cli.ts analyze --plan poc/bench/results/three-way-smoke
```

The default smoke has 44 slots: 12 host, 16 direct-runtime, and 16 paid task slots. One H03 slot is not applicable. Select `--suite host`, `runtime`, `end-to-end`, `all`, or comma-separated lanes/case IDs. Use `--variants prime-ts,prime-rust,wasmedge,wasmedge-aot`, `--reps N`, and `--seed N` to set the matrix.

The single-Opus 12-task pilot has 144 runs (four variants × three repetitions). A ten-repetition formal plan has 480 runs. Prepare, discover, plan, and analyze do not generate paid responses. Only end-to-end slots in `run` use paid calls. Each run permits at most 64 HTTP requests, including retries, and has a task-specific total deadline.

## Larger workloads without model calls

The opt-in `workloads` suite implements N01 dependency-graph BFS, N03 streaming event transitions, and N04 u32 queue simulation. Existing `runtime` and `all` selections remain unchanged. Run a small correctness smoke before the scale pilot:

All 180 reference runs in the [first standalone pilot report](../../../docs/benchmark-rust-cell-workloads-2026-10-10.html) passed. Large N04 reference has a median paired AOT roundtrip speedup of 1.779×, including Cargo/AOT. Graph/events and the interpreter did not win full roundtrip. This is descriptive, without formal ranking.

```sh
npx tsx poc/bench/three-way/cli.ts plan --suite workloads --scales small --reps 1 --out poc/bench/results/workloads-smoke
npx tsx poc/bench/three-way/cli.ts run --plan poc/bench/results/workloads-smoke
npx tsx poc/bench/three-way/cli.ts analyze --plan poc/bench/results/workloads-smoke
npx tsx poc/bench/three-way/cli.ts plan --suite workloads --scales small,medium,large --reps 5 --seed 20261010 --out poc/bench/results/workloads-pilot
npx tsx poc/bench/three-way/cli.ts run --plan poc/bench/results/workloads-pilot
npx tsx poc/bench/three-way/cli.ts analyze --plan poc/bench/results/workloads-pilot
```

Select families with `--suite N01-graph,N03-events,N04-simulation`, or exact condition IDs. `--batches 1,4,16,64` partitions the same total work. `--cache cold,warm --warmups 2` chooses fresh workspaces or full warmup cycles in the same workspace. Cold retains prepared toolchain/template and OS caches. Each Rust cell still compiles; graph/event state uses blobs while Python retains resident objects. `--event-format binary,jsonl` and `--simulation-mode prng,events` create separate controls. The comparison fixes identical algorithms, Python standard library and Rust.

Each cell must produce fresh output; prior batch output is removed before submission. Host-only oracles check complete output after each cell and input hashes after the final cell. Graphs use 4V edges and 64/128/256 queries. Event decode/I/O/transitions share a streaming phase. OMP/OpenBLAS/MKL/NumExpr thread limits are fixed at one. `workloads.html/json/csv` show scale curves, all planned slots, failures, and phase medians. Warmups are excluded from measured roundtrip/phase totals; validated total includes startup, warmups, checks, and disposal. Runtime execution is measured directly from runtime phases, excluding Cargo/AOT, initialization and snapshots; process/VM startup and I/O remain. Roundtrip and validated total include compilation. Historical non-reference conditions are excluded from comparisons; raw records are retained. This descriptive pilot has no formal ranking or audited confidence intervals. See the [design and implementation record](../../../docs/benchmark-rust-cell-workloads-2026-10-10.md).

The standalone report explains all 13 columns, cache conditions, units, medians and missing values. A timing selector provides three workload charts for each of five boundaries: roundtrip minus Cargo/AOT, directly measured runtime execution, guest compute, validated total minus Cargo/AOT, and raw roundtrip. Deductions merge verified command intervals per run, clip to the selected period, subtract once, then take medians. Incomplete capture or clocks remain unavailable; chart n counts successful runs with that metric.

This timing pilot contains cold only. Warm correctness smokes are separate. For a paired cold/hot experiment, create a new plan using identical source, fixture seeds, work and cell counts with `--cache cold,warm --warmups 2`. Warm still performs the same algorithmic work. Rust starts a fresh process/VM per cell and AOT recompiles each cell; there is no artifact cache. Validated total retains warmup costs.

## Cell-only task rules

The default `--tool-policy runtime-only` compares Python cells/runtime with Rust cells/Wasm runtime. TS exposes only ipython; the fork exposes only rust; the Rust upstream has its single Python tool. Every turn requires a successful cell. Reads, parsing, computation, edits, and writes must use the cell language's APIs. Shell/subprocess delegation is prohibited.

Common `node --test`, `cargo test`, lint, and other fixture checks run after the agent finishes. Their time is separate. These rules differ from the native product loop. Each run saves `cell-audit.json`, generated Python/Rust sources, and per-turn prompt hashes. Passing the checker without meeting the cell rules is a failure. Automated source screening is not a security boundary; sources still need inspection.

`--tool-policy native` is only a tool-choice observation. Old bash trajectories keep their raw records and checker results but are excluded from cell latency. Policies have different case inputs/hashes and cannot be pooled. Native project Cargo target/build directories are isolated per run. Cell engines retain their own target policy.

## Command profiling and source integrity

`--profile-commands true` creates a separate profiling lane. PATH wrappers preserve output/status and record Cargo/rustc/node/python spawn-to-close time, arguments, cwd, and outcome. Native builds, tests, runs, and control-cell Cargo are classified separately. `cargo test` remains a combined build/test bucket. rustc unit totals are not Cargo wall time. Absolute executable paths can bypass wrappers and require explicit coverage checks. Wrapper overhead is not yet audited; profiling results are not pooled with default results.

Manifests pin source/build/collector hashes, task snapshots, inputs, model ID, seed, and order. Runs reject source drift. Resume skips only complete slots and retains interrupted/infrastructure failures. Do not overwrite failed evidence or replace it with a hidden rerun. Create a new plan for retesting. Keep the plan directory in its original location.

Model credentials stay in the reverse gateway. Isolated agent configurations use a random local token without paid-provider authority. Each request saves body, SSE, decoded arguments, usage, chunk timestamps, session logs, project output, and failures. Raw directories use mode 700; sensitive records use 600. The API key is absent from manifests, config, child environment, and command lines.

## Implemented coverage

| Lane | Cases | Method |
|---|---|---|
| H | H01 startup, H02 fixed UTF-8 stream, H03 ten shell calls | HTTP/SSE replay; no paid model |
| R | R01–R16 small reference programs | Real product cell engines; identical upstream Python; equivalent Rust with assertions/markers |
| E | Cell-controlled versions of the original 12 tasks | Native prompts, cell tools, common Opus route/fixtures/checkers |

H01/H02 preserve native prompts and metadata and replay the same responses. They are not identical-request parser tests. H03 is not applicable to the Rust CLI. R10 uses the common `/bin/sh` handler through the bridge. R15 uses independent sessions, not RLM children. R11 compares Python namespace checkpoints with Rust blobs/Git under their different contracts. R04 reports resident and reparse steps separately.

Designed scales, cold host caches, compiler internals, crash recovery, full library-gate cases, and E13–E15 are not all implemented. R02 clears only its owned target; OS/toolchain/template caches stay warm. R16 currently has 100 no-op cells, without the planned state change every ten cells.

## Reports and timing

Per-run output includes `spans.jsonl`, `events.jsonl`, and `result.json`. Analysis writes `report.html`, `report.json`, run/phase/request CSVs, and phase summaries. HTML supports case/variant/phase/state/outcome filters and run/cell/request search. Failures remain saved. Task failures use the predefined deadline in penalized mean. Infrastructure errors are separate and block completeness.

Observed phases include gateway headers/body/content/reasoning/stream, tool/source emission, code-ready, tool execution, admission/provision, source/gates/queues/Cargo/policy/probe/execution/cleanup/snapshot/residual, reference guest I/O/compute/state/bridge/output, checker, and teardown.

`llm.code_emission` is a client-visible SSE window mapped to a JSON source field. It is not pure server generation. Code-ready starts at gateway receipt and excludes unobserved earlier prompt work. Independent duration summaries have separate clocks and cannot form a global timeline. Parent/child and bridge durations are not additive.

Python bytecode/import detail, rustc typecheck/codegen/link, host result/transcript work, launch/drain detail, exact CPU, and tree RSS remain missing when hooks are absent. A compile rejection means execution did not run. No missing or cached phase is filled with zero. Wall minus CPU is not an I/O timer.

`rankingAllowed:false` remains set. Smoke validates the harness and describes measured costs. A formal ranking requires adequate samples, paired confidence intervals, and an overhead audit with a 95% upper bound ≤2%. Usage remains as reported by the service. No pricing means no estimated money cost. See the [validation history](../../../docs/bench-history/benchmark-three-way-validation-2026-10-08.en.md).

## All Cargo and AOT deductions

For each successful, cell-compliant run, merge all captured compiler intervals, clip them to the selected period, subtract once, then take the median. Raw and adjusted bars use identical samples. Default validated time includes initialization through checker completion. Agent/user end before the checker.

All Cargo includes initialization, skill probes, cells, library gates, project build/test, helper commands, and retries. Full `cargo test` wall time includes test execution. Do not add `cell.compile` or rustc child time again. Python checkers can also run Cargo.

The default Cargo-only wrapper captures the pinned runtime's PATH and `WASMEDGE_AGENT_CARGO` entries and saves `cargo-commands.jsonl`, `cargo-capture.json`, and `cargo-clock-calibration.json`. Three child samples check clock alignment. Missing endpoints, duplicate IDs, bad clocks, or absent old capture make the metric unavailable. Custom absolute paths outside these entries are outside verified scope. Node-wrapper startup stays in the remainder. This is an arithmetic deduction, not a rerun without Cargo.

AOT is an added fourth group. Both Wasm variants share reference sources and readiness bridge. The host compiles every inspected/stripped cell with no cache. Rust→Wasm uses `cargo.command`/`cell.compile`; Wasm→AOT uses `aot.command`/`cell.aot_compile`. AOT compiler capture uses `aot-commands.jsonl`/`aot-capture.json` and the calibrated collector clock. Runtime itself is not wrapped as compiler work.

Select all Cargo or all Cargo plus AOT. Combined deductions merge overlapping intervals. `agentWithoutAllCompilationMs`, `userWithoutAllCompilationMs`, and `validatedWithoutAllCompilationMs` include both command types. Older `*WithoutCompilationMs` fields deduct all Cargo only. Incomplete AOT capture leaves the combined metric unknown. Separate campaign hashes prevent pooling old and new bridge conditions.

## Cell execution charts

Cell rows use `cell.python_execute` and `cell.execution`, not buffered CLI events. They show calls, success/runtime/Cargo/AOT failures, execution total, successful-cell average, failed execution, and state. They exclude model output, Cargo/AOT, initialization, and snapshots. Runtime boundaries retain launch, I/O, and bridge work. Python uses a resident kernel; Rust starts a process/VM per cell.

Charts show either per-run totals or the average per successful cell, in ms, then take medians across comparable runs. n counts runs. They support linear/log scales, case/variant filters, bar focus, tooltips, SVG export, and trace links. The CSV is `cell-execution-runs.csv`; JSON rows are `report.json.cellExecutionRuns`. Runtime failure costs remain; compile failures have no execution. Parallel totals are work, not wall time. A Python 0 ms report is below resolution. Different generated programs/call counts are not a fixed-program speed ratio.

## English report export

```sh
uv run --with markdown==3.10.2 python poc/bench/english-report.py
```

This rebuilds both standalone reports and the nine English supporting readers. It reads tracked prose, aggregate data, and SVGs; it does not rerun experiments or call a model. Share `docs/rust-cell-report-2026-10-08.en.html` directly. Original dashboards, screenshots, provider records, and generated task outputs stay local.

`poc/bench/results/` stays ignored. Git keeps the standalone readers, compact aggregate data, SVGs, templates, and scripts. PNG screenshots, raw traces, generated outputs, and dashboards remain local. `npm run check:benchmark-reports` validates links and the standalone readers. Rebuild with `uv run --with markdown==3.10.2 python poc/bench/consolidated-report.py`; it needs no raw results and makes no model calls.
