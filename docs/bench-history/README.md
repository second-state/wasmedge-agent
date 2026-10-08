# Historical benchmark evidence

Start with the current standalone report: [English](../rust-cell-report-2026-10-08.en.html) or [繁體中文](../rust-cell-report-2026-10-08.html).

This directory keeps different experiments and diagnostic controls. They are not subsets of one common run and must not be pooled with the latest four-way results.

| Record | Purpose | Markdown source | English HTML |
|---|---|---|---|
| August 6 M1 | PoC acceptance, compile-error recovery, and few-shot comparison | [Source](m1-measurement-report.md) | — |
| August 7 M5 | Fork acceptance against earlier M1 results | [Source](m5-acceptance-report.md) | — |
| August 10 benchmark | Twelve tasks, two models, three repetitions per group | [English source](benchmark-comparison-2026-08-10.md) | [Reader](../benchmark-comparison-2026-08-10.en.html) |
| October 7 microbenchmark | Ten runtime-phase scenarios, five repetitions, no model calls | [English source](runtime-microbenchmark-2026-10-07.md) | [Reader](../runtime-microbenchmark-2026-10-07.en.html) |
| October 8 runtime diagnosis | Pre-update native/Python body timers, process cost, and polling controls | [中文](benchmark-cell-runtime-analysis-2026-10-08.md) / [English](benchmark-cell-runtime-analysis-2026-10-08.en.md) | [Reader](../benchmark-cell-runtime-analysis-2026-10-08.en.html) |
| October 8 validation history | Earlier campaigns, failed adapters, protocol corrections, and Cargo capture | [中文](benchmark-three-way-validation-2026-10-08.md) / [English](benchmark-three-way-validation-2026-10-08.en.md) | [Reader](../benchmark-three-way-validation-2026-10-08.en.html) |

The August benchmark and October microbenchmark were already written in English. Each now has one Markdown source. The AOT/bridge results and implementation checks are integrated into the current report; its [supporting HTML](../benchmark-aot-bridge-2026-10-08.en.html) is generated from that report.

All nine supporting English HTML readers retain their existing paths. They can link to source files and shared SVG assets; use the current report above for single-file sharing. Regenerate them with `uv run --with markdown==3.10.2 python poc/bench/english-report.py`. Raw traces, screenshots, generated task outputs, and local dashboards remain in ignored result directories.
