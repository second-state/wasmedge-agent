# Historical WasmEdge cell experiments

The October benchmarks measured a different host and toolchain. The original extension, runners, fixtures and reproduction instructions are available together at [the measured revision](https://github.com/second-state/wasmedge-agent/tree/630cb342f419831ac18d74435ba12b4c14b0a81f/poc).

To reproduce those runs in a separate checkout:

```sh
git worktree add --detach ../wasmedge-agent-benchmark 630cb342f419831ac18d74435ba12b4c14b0a81f
```

The [benchmark reports](../docs/README.md) contain the published results and aggregate data. The [native worker integration tests](../crates/pa-cli/tests/native_cells.rs) exercise the current Rust worker with a scripted provider.
