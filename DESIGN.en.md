# Rust Cell Design: English Reading Guide

This is an English guide to the architecture and decision log. It is **not a full translation** of every historical design note or code appendix. The authoritative [design document](DESIGN.md) is in Chinese. The full [runtime reference](packages/coding-agent/docs/rlm-runtime.md) is already in English and documents the implemented settings, APIs, and limits. The [consolidated report](docs/rust-cell-report-2026-10-08.en.md) describes current evidence.

## Architecture

The TypeScript host owns provider credentials, sessions, handlers, goals, compaction, and child agents. Rust cells compile to `wasm32-wasip1` and run in a new WasmEdge process. The guest uses non-network WASI imports, explicit directory mounts, and a private stdio bridge. Direct network access is rejected. Host handlers and bash keep host permissions.

Each cell is a complete program. It does not preserve arbitrary objects across cells. `agent_lib` stores reusable source; state/blob files store data; project files remain on disk. Build rejection restores staged source. Successful cells attempt Git snapshots. External effects are not atomically rolled back. Snapshots do not provide complete deterministic replay.

Interpreter is the default. Optional AOT inspects imports, removes guest custom sections, compiles on the host, verifies the output, and records provenance. AOT has no cache. Gas, memory-page, read-only-project, compiler-sandbox, and process-tree settings have distinct scopes. See the runtime reference for exact defaults and platform support.

## Decisions D1–D26

Decisions describe intent. Historical plans are not proof of implementation. Later notes and the runtime reference determine what has shipped.

| ID | Decision and reason |
|---|---|
| D1 | Use Rust cells in Phases 0–2. Keep a driver boundary for possible later languages. |
| D2 | Project mount is writable by default. Read-only mode restricts the guest; host tools remain separate. |
| D3 | Begin with socket CLI transport, move to CLI/stdio, and keep embedded host functions as the later T2 design. |
| D4 | Use a random 64-hex session bearer token and active cell ID. Private cell pipes carry the current protocol. |
| D5 | Version workspace files in Git and guard library edits. Snapshots cover defined files, with no fixed commit-time or full-replay guarantee. |
| D6 | Name the tool `rust`. Do not reuse `ipython` and trigger Python-specific behavior. |
| D7 | Write a new prompt for general frontier models. |
| D8 | Use `wasm32-wasip1` core modules. Component Model/wasip2 is a later path. |
| D9 | The runner denies guest networking through import inspection. Default interpreter; optional AOT must strip and rebuild native payloads on the host. Host compiler/bash/handlers are outside this policy. |
| D10 | Use wasmedge-agent as the working identity; formal naming was deferred to M5. The later rename has shipped. |
| D11 | Accept no long-lived guest process and possible data reload per cell. Save processed results explicitly. A resident service needs evidence first. |
| D12 | External guest I/O is host-mediated as a product principle. Host authority remains explicit. |
| D13 | Keep `rust` and `bash` as separate built-in tools. Guest isolation is not a whole-agent sandbox. |
| D14 | Edit reusable source through the declarative `lib` argument. `/agent/lib` is read-only to the guest. Failed builds/interrupts restore source; runtime effects are not transactional. |
| D15 | Start with a fixed prelude. Later dependencies use host-managed curated resolution and vendoring. |
| D16 | Prefer Rust APIs for file reads/search/edits. Native project commands use bash in the product loop. The cell-only benchmark has stricter rules. |
| D17 | Test a complete few-shot example in a prompt sub-A/B. Its fixed token cost must be compared with repair cost. |
| D18 | Planned child inheritance: copy parent library and target state, start data state empty. See runtime documentation for current child-inheritance coverage. |
| D19 | Start with guidance for skill tests; enforce model-written tests inside Wasm rather than native host execution. |
| D20 | Legacy acceptance: pass rate at least baseline minus 15 percentage points, output-token ratio ≤2.0, with at least two models passing. This is a stop-loss gate. |
| D21 | Legacy model roles: Sonnet class, Opus/Fable class, and one open-weight family. Original budget estimate: about 216 runs and $200–600. The current single-Opus test does not replace this matrix. |
| D22 | Develop first under `hydai/wasmedge-agent`; transfer to the organization after M5 acceptance. |
| D23 | Develop independently. Defer upstream coordination until the design matures. |
| D24 | Use an independent repository with attribution rather than GitHub's fork mechanism. |
| D25 | Retain upstream names during incubation; rebrand at M5. The canonical name is now `wasmedge-agent`, with `WASMEDGE_AGENT_*` and `~/.wasmedge-agent`. Only documented temporary fallbacks remain. |
| D26 | Make the repository public during M2 to use public GitHub Actions. This supersedes private incubation. |

## Work packages and roadmap

The fork replaces the Python kernel/tool/guest shim and updates session wiring, prompts, rendering, skills, harness integration, and installation. Provider code, agent loop, TUI framework, daemon, session storage, and general compaction remain reusable. Sync strategy keeps runtime-exclusive directories separate and lists shared-file changes explicitly.

Historical milestones were M0 prototype, M1 feasibility gate, M2 cell engine, M3 bridge/children/rendering, M4 skills/harness/install, M5 acceptance/dogfooding, and M6 later runner work. The schedule assumed one full-time engineer. It is a historical plan, not a current delivery forecast.

Future work includes an embedded runner, trusted artifact reuse, broader dependency support, replay inputs, and local inference integration. Each requires separate implementation and validation. Use the [English benchmark protocol](docs/benchmark-three-way-design-2026-10-08.en.md) for measurement requirements and the [English feasibility report](REPORT.en.md) for the original rationale.
