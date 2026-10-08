# Four-Way Agent Benchmark Runner

Compare `prime-ts`, `prime-rust`, `wasmedge` (interpreter), and `wasmedge-aot`. The model route is `anthropic/claude-opus-5-5`, with reasoning off. This ID comes from the service catalog. An immutable backend revision is not independently verified. The older A/B/F harness and D20/D21 rules remain separate.

Start with the [English safety and performance report](../../../docs/rust-cell-report-2026-10-08.en.html), also available as [Markdown](../../../docs/rust-cell-report-2026-10-08.en.md). It covers architecture, safety tests, fixed programs, Opus tasks, Cargo, AOT, and the bridge.

[Download the offline English package](../../../docs/assets/rust-cell-report-2026-10-08/english-report-set.zip) to read the saved dashboards and linked CSV tables. Extract it and open `docs/rust-cell-report-2026-10-08.en.html`. Raw evidence links require the original local run directories.

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

`rankingAllowed:false` remains set. Smoke validates the harness and describes measured costs. A formal ranking requires adequate samples, paired confidence intervals, and an overhead audit with a 95% upper bound ≤2%. Usage remains as reported by the service. No pricing means no estimated money cost. See the [validation history](../../../docs/benchmark-three-way-validation-2026-10-08.en.md).

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

This creates additional `.en.md`/`.en.html` reports, `report.en.html` dashboard copies, a validation record, and an offline ZIP. It does not modify Chinese reports, reanalyze measurements, or call models. Dashboard data scripts are copied byte-for-byte. Raw traces and code keep their original language. Start with `docs/rust-cell-report-2026-10-08.en.html` after extracting the ZIP. Raw evidence/source links require the full repository archive.
