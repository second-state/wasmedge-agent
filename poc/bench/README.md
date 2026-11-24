# Benchmark evidence and readers

Rebuild the published standalone HTML readers from tracked data, without model requests:

```sh
uv run --with markdown==3.10.2 python poc/bench/english-report.py
```

The [report index](../../docs/README.md) describes each campaign. The [historical runner and fixtures](https://github.com/second-state/wasmedge-agent/tree/630cb342f419831ac18d74435ba12b4c14b0a81f/poc/bench) reproduce the measured host. See the [checkout instructions](../README.md).
