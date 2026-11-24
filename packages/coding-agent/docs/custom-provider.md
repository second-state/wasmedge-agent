# Custom providers

For an endpoint that implements a supported API, set its base URL, API, credentials and models in `~/.wasmedge-agent/models.json`. See [custom models](models.md) for the configuration format and examples.

An embedded application can supply its own model and `StreamFn` in `SessionEngineConfig`. The [Rust SDK guide](sdk.md) shows session construction and provider selection. Use the [historical provider extension guide](https://github.com/second-state/wasmedge-agent/blob/630cb342f419831ac18d74435ba12b4c14b0a81f/packages/coding-agent/docs/custom-provider.md) when porting an older extension.
