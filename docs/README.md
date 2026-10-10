# Documentation

**Start with the [October 10 Opus 5.5 E2E results](benchmark-rust-cell-e2e-2026-10-10.md)** to understand whether Rust cells improve a complete agent task. The model actually generates, executes and repairs code. Open the [E2E charts](benchmark-rust-cell-e2e-2026-10-10.html) for the visual comparison.

Use Markdown for reading on GitHub. Download an HTML report and open it locally for its charts. English is the primary reading path; older reports also have Traditional Chinese counterparts.

## Recommended reading order

| Order | Report | What it answers |
|---|---|---|
| 1 | **[Real-model E2E results — October 10](benchmark-rust-cell-e2e-2026-10-10.md)** · [Charts](benchmark-rust-cell-e2e-2026-10-10.html) | Does the full agent workflow benefit? Includes model requests, generated cells, repairs, compilation and independent validation. Explains all three tasks and the five timing charts. |
| 2 | **[Fixed-program workloads — October 10](benchmark-rust-cell-workloads-2026-10-10.md)** · [Charts and column guide](benchmark-rust-cell-workloads-2026-10-10.html) | Where does execution time go when equivalent programs run without a model? Covers graph traversal, streaming event transitions and integer queue simulation, with the complete 13-column guide. N02/N05/N06 are proposals, not measured results. |
| 3 | **[Architecture, safety and earlier results — October 8](rust-cell-report-2026-10-08.en.md)** · [Standalone HTML](rust-cell-report-2026-10-08.en.html) | How does the runtime work, what safety controls were tested, and what did the earlier runtime/agent/bridge experiments show? Its results predate the October 10 workload campaigns. |

The [small E2E smoke report](benchmark-rust-cell-e2e-smoke-2026-10-10.html) verifies correctness and measurement coverage. Use the large pilot above for the current E2E comparison. Campaigns with different workloads, scales or controls remain separate.

## Choose the timing boundary

The October 10 reports distinguish these measurements:

| Measurement | Cargo/AOT included? | Model included? | How to read it |
|---|---|---|---|
| Full validated E2E | Yes | Yes | Complete measured workflow through the external checker, including compilation failures and repairs. |
| E2E minus Cargo/AOT | No | Yes | Measured E2E after deducting verified compiler intervals. |
| E2E minus Cargo/AOT and model requests | No | No | Remaining host, runtime, I/O, snapshot and validation time after interval deductions. |
| Runtime execution | No | No | Direct runtime measurement. Retains process/VM startup and I/O within that boundary; excludes initialization and snapshots. |
| Model request sum | No | Yes | Sum of request durations, which can overlap cell work. Do not subtract it from the median E2E total. |
| Guest compute (fixed-program report) | No | No | Instrumented algorithm body, useful for explaining the execution cost. |

Adjusted E2E values are arithmetic deductions from the same real-model runs. They are not reruns without the model or compiler. Overlapping compiler/model intervals are merged and clipped to the measured window before subtraction; medians are then taken across runs. When a model request overlaps cell execution, that overlapping wall time is removed too. Phase medians are not additive, and that remainder is not pure compute.

Both current pilots measure **cold workspaces**, retaining prepared toolchain/template and OS caches. AOT still recompiles each cell. Warm/hot timing requires a separate controlled campaign; it is not part of these published pilots. Small sample counts support descriptive comparisons, not a formal overall ranking. Python comparisons use the standard library; NumPy is excluded.

## Understand the four variants

| Variant | Agent host | Cell language and runtime |
|---|---|---|
| `prime-ts` | TypeScript | Python |
| `prime-rust` | Native Rust | Python — “Rust” here names the host, not the cell |
| `wasmedge` | TypeScript | Rust/Wasm, interpreted by WasmEdge |
| `wasmedge-aot` | TypeScript | Rust/Wasm, compiled to AOT for each cell |

## Reproduce results or inspect evidence

Follow the [English runner instructions](../poc/bench/three-way/README.en.md) for requirements, commands and capture rules. Use `workloads` for fixed programs without model calls, or `workloads-e2e` for real model-generated solutions. `analyze` reuses saved traces without calling a model. The [four-way protocol](benchmark-three-way-design-2026-10-08.en.md) describes the broader benchmark design; each dated report identifies its implemented and measured subset.

Portable aggregate data: [fixed-program pilot](bench-data/workloads-pilot-2026-10-10.json), [large E2E pilot](bench-data/workloads-e2e-pilot-2026-10-10.json), and [E2E smoke](bench-data/workloads-e2e-smoke-2026-10-10.json). Raw requests, generated code and traces remain in ignored local result directories.

Use the [historical evidence index](bench-history/README.md) for older acceptance runs, campaigns and diagnostic controls. Supporting HTML readers explain those records; they are not additional current workload campaigns.

## Implementation and project design

- [Runtime reference and trust boundary](../packages/coding-agent/docs/rlm-runtime.md): cell lifecycle, persistence, host capabilities and configuration.
- [Design decisions](../DESIGN.md): the project's implementation authority and future work.
- [Feasibility study](../REPORT.md): the original runtime-swap proposal.
- [Read-only preopen investigation](wasmedge-readonly-preopen-investigation.md): a specific runtime capability investigation.
- [Guided showcase](../examples/showcase/README.md): install and try the agent on a small fixture project.
