# Extending the native agent

Use a [resource package](packages.md) for skills, prompt templates and themes. A package can live in a local directory or a Git repository.

For executable tools, embed the [Rust SDK](sdk.md). Define a `ToolDefinition`, convert it with `bridge_tool`, and supply it in `SessionEngineConfig.tools` when constructing the session. The SDK also exposes `HostRequestHandlers` for guest requests. For an out-of-process application, the [RPC protocol](rpc.md) exposes the CLI over JSON lines.

The [previous extension API](https://github.com/second-state/wasmedge-agent/blob/630cb342f419831ac18d74435ba12b4c14b0a81f/packages/coding-agent/docs/extensions.md) documents the historical host. Existing extensions that registered in-process callbacks need to port those callbacks to their Rust embedding.
