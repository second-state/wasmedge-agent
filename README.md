# wasmedge-agent

**A runtime-swap fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent): the model writes Rust instead of Python, and every cell runs sandboxed in [WasmEdge](https://github.com/WasmEdge/WasmEdge).**

Status: the core Rust/WasmEdge runtime is implemented; further design work is
tracked in `DESIGN.md`. The public
surface is the fork's own: the command is `wasmedge-agent`, the environment
prefix is `WASMEDGE_AGENT_*`, and configuration lives in `~/.wasmedge-agent`.
`DESIGN.md` D25 held those at upstream identities until M5; that rename has
since landed. The inherited npm workspace identifiers in the source tree are
implementation details, not the public install path.

## What changes, what stays

The benchmark baseline's design — one programmatic control-environment tool, recursive
`rlm(...)` subagents, the continual harness — stays. What this fork replaces is
the runtime under it:

| | Benchmark baseline (`c22549a3`) | This fork |
|---|---|---|
| Host harness | TypeScript | Retained and adapted TypeScript harness |
| Model-facing tool | `ipython` (persistent kernel) | `rust` (cell = complete program) |
| Execution | host Python, no sandbox | `wasm32-wasip1` in WasmEdge, capability-scoped preopens |
| Persistence | in-memory namespace + dill snapshots | explicit: `rlm::state` KV/blobs + growable `agent_lib` crate + files |
| Feedback loop | runtime tracebacks | rustc diagnostics (compile errors are first-class feedback) |

This comparison describes the pinned baseline, not today's upstream main.
The fork changes tool registration, session wiring, prompts, and persistence
as well as the cell runtime. Cell builds are mandatory; sandboxed tests gate
skill registration, not every edit. The runner rejects direct guest network
imports and uses a stdio bridge for host capabilities. Linux users can opt into
`rustCell.cargoSandbox: "bubblewrap"` to isolate compiler subprocesses and
`rustCell.processLimits` to bound each Cargo/WasmEdge invocation's memory,
CPU bandwidth and process/thread count through cgroup v2.
`rustCell.treeProcessLimits` optionally shares a runtime budget across the root
session and its subagents. Cargo
retains host permissions by default; host bash and handlers do so in either mode. See the
[runtime architecture and trust boundary](packages/coding-agent/docs/rlm-runtime.md).

Evidence and design:

- **Start here:** [Documentation guide](docs/README.md) — the English reading order, report purposes, timing boundaries and data links.
- **Latest benchmarks (October 10):** [real-model E2E results](docs/benchmark-rust-cell-e2e-2026-10-10.md) and [fixed-program workloads](docs/benchmark-rust-cell-workloads-2026-10-10.md), each with charts and task explanations.
- **Architecture, safety and earlier results (October 8):** [English](docs/rust-cell-report-2026-10-08.en.html) / [繁體中文](docs/rust-cell-report-2026-10-08.html). Download either standalone HTML file and open it locally for conclusions, charts, key tables, safety evidence, and separate Cargo/AOT costs.
- **Methods:** [benchmark protocol](docs/benchmark-three-way-design-2026-10-08.en.md) and [runner instructions](poc/bench/three-way/README.en.md).
- **Historical evidence:** [campaigns and diagnostic records](docs/bench-history/README.md). These use different controls and are kept separate from the current results.
- **Project design:** [feasibility study](REPORT.md), [design decisions](DESIGN.md), and [runtime reference](packages/coding-agent/docs/rlm-runtime.md).

Rebuild the October 8 standalone reports with `uv run --with markdown==3.10.2 python poc/bench/consolidated-report.py`. The English exporter also regenerates their nine supporting HTML readers. It uses saved data and makes no model calls. For the October 10 workload reports, use the runner's `analyze` command described in the [documentation guide](docs/README.md).

## Try it

A guided 30–45 minute session — install the toolchain, open the agent on a
small ops-style fixture project, and run five missions that each show one
thing the runtime swap changes (sandboxed cells, explicit persistent state,
compile-errors-as-feedback, recursive subagents, a growable agent_lib):

**[examples/showcase/README.md](examples/showcase/README.md)**

## Attribution

This repository carries the full history of and is built on
[**Prime Agent**](https://github.com/PrimeIntellect-ai/prime-agent) by
[Prime Intellect](https://primeintellect.ai) (MIT), which in turn builds on
[**pi**](https://github.com/badlogic/pi-mono) by Mario Zechner and contributors
(MIT). We are grateful to both. Upstream's documentation lives on under
`packages/coding-agent/docs/`; the original upstream README is preserved in git
history.

## License

MIT — see `LICENSE`.
