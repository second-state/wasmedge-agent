# Runtime phase microbenchmark — October 7, 2026

This is a model-free measurement of the current persisted Rust cell tool:
10 fixed scenarios × 5 serial repetitions, 50 cell results. It is separate
from the August 6 feasibility study and August 10 model comparison. No model
calls, task success-rate comparison, D20/D21 verdict, or before/after speedup
was measured.

## Method and provenance

- Apple M5 Max, 18 logical CPUs, 128 GiB RAM, macOS arm64 (Darwin 25.6.0).
- Node 24.13.1, rustc/Cargo 1.98.1, WasmEdge 0.14.1, `wasm32-wasip1`, release/interpreter.
- UTC October 6, 21:21:15–21:22:26 (October 7 in Asia/Taipei).
- Based on `346a2eb038ad6cdd8b7848cd6acdffa694b865c4` plus this PR's timing changes.
  The worktree was dirty. The raw artifact lists and hashes measured source
  files, hashes the selected template separately, and checks both at the end.
- Template vendoring/warming happened before the campaign. Each repetition
  started a fresh persisted workspace; all successful cells attempted Git
  snapshots. The fixed scenario order is in the [driver](../../poc/bench/runtime.ts).
- Gas/page limits and rustdoc queries were disabled; only the final scenario
  enabled the library test gate. Builds were offline. No other repository
  tests/builds were run concurrently with this campaign; host background load
  was not controlled.

[Raw JSON: all 50 samples and environment](../runtime-microbenchmark-2026-10-07.json)
has SHA-256 `aa5a8924dea830d4dac0bef7b907512efd1e59ee084542ce7dd74734e446885e`.
The measured-source SHA-256 is
`40908972a83666a048558b155428c4714f74e43336a2986ccd0c88668dd5b54d`.
These fingerprints do not cover installed binaries, Node dependencies, vendor
contents or arbitrary host configuration.

## Results

All values below are milliseconds. `med` is the sample median; p95 uses
sorted index `floor(n × .95)`, capped at the final index. With only five samples,
p95 is the observed maximum, not a reliable population-tail estimate. Phase
medians need not sum to the median total. Zero means the phase was not reached
or enabled in these samples; every phase is present in the raw JSON.

| Scenario | Runner med | Runner p95 | Tool med | Cargo med | Execution med | Git med | Library tests med |
|---|---:|---:|---:|---:|---:|---:|---:|
| template-first | 3823.1 | 4529.2 | 4193.8 | 3768.0 | 7.5 | 39.9 | 0.0 |
| unchanged | 115.7 | 123.4 | 115.8 | 70.3 | 7.9 | 37.3 | 0.0 |
| cell-edit | 123.4 | 128.5 | 123.4 | 75.8 | 7.8 | 39.8 | 0.0 |
| library-edit | 165.6 | 185.9 | 165.6 | 115.6 | 8.0 | 42.2 | 0.0 |
| bridge-100 | 855.7 | 870.7 | 855.7 | 137.4 | 661.3 | 57.4 | 0.0 |
| state-64k | 158.1 | 163.3 | 158.2 | 101.2 | 13.8 | 42.4 | 0.0 |
| compile-error | 54.7 | 55.6 | 54.7 | 54.3 | 0.0 | 0.0 | 0.0 |
| recovery | 140.5 | 142.4 | 140.5 | 87.1 | 13.7 | 39.5 | 0.0 |
| cold-target | 3078.1 | 3272.0 | 3078.2 | 3030.0 | 8.1 | 39.8 | 0.0 |
| library-test-gate | 4896.2 | 4899.6 | 4944.5 | 117.3 | 7.3 | 41.8 | 4720.1 |

The 45 successful results and five intentional compile errors matched their
expected statuses; bridge/state/library scenarios include assertions. Source
fingerprints remained unchanged. This validates these small scenarios only.

## Interpretation and limits

- First use from the warm template still spent a median 3,768 ms in Cargo.
  A copied target is not a guaranteed reusable cache; the run did not capture
  Cargo's invalidation reasons. This is a separate condition from the subsequent
  unchanged-cell scenario, where the tool still rewrites `main.rs`.
- The unchanged/changed/library-edit scenarios spent roughly 37–42 ms in Git
  snapshot attempts. That supports measuring Git separately; it is not a fixed
  commit cost for larger state or repositories.
- The bridge scenario issues 100 synchronous echo requests over stdio; its
  handler echoes the received payload, including the injected source field.
  Its 661 ms execution median includes process startup, protocol work and
  handler waits. It is not guest-only CPU time or an isolated bridge latency.
- State uses one 64 KiB blob write/read per cell. Recovery reruns the preceding
  successful state program after a deliberate type error; no model repairs it.
- Cold target removes only that workspace's `target/`. OS and toolchain caches
  remain warm. The library-gate scenario reloads the provisioner, stages an edit
  with one passing test, and includes test snapshot/build/run/cleanup costs.
- Tool time includes provisioning; runner time excludes provisioning and the
  per-runner queue. All phase definitions are in the
  [runtime documentation](../../packages/coding-agent/docs/rlm-runtime.md#cell-timing).
  Neither total includes model latency or subsequent transcript/UI processing.

Reproduce with the [offline driver instructions](../../poc/bench/README.md#runtime-microbenchmark).
These fixed-order samples on one host do not establish broad performance,
concurrency behavior, a runtime-versus-diagnostics causal split, or improved
model correctness. The formal multi-model benchmark remains to be rerun.
