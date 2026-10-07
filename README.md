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
CPU bandwidth and process/thread count through cgroup v2. Cargo
retains host permissions by default; host bash and handlers do so in either mode. See the
[runtime architecture and trust boundary](packages/coding-agent/docs/rlm-runtime.md).

Evidence and design:

- [August 10 benchmark](docs/benchmark-comparison-2026-08-10.md): 12 distinct tasks, two models, three repetitions per group; fork 72/72 runs versus baseline 69/72, with higher wall time and output-token usage. All baseline failures were one Sonnet rename task; this does not isolate a compiler effect.
- [M1 PoC report](docs/m1-measurement-report.md): a separate August 6 campaign with 146 runs including two smoke runs; treatment passed 73/73. Its recovery measurements are not from the August 10 benchmark.
- [Feasibility study](REPORT.md), [design decisions](DESIGN.md), and [PoC source](poc/): historical measurements, planned work, and implementation notes.

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
