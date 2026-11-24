# Terminal UI

The native terminal interface lives in the [pa-tui crate](../../../crates/pa-tui/src/lib.rs). It renders session events, tool results, Markdown and configurable [keyboard shortcuts](keybindings.md).

To build a separate client, consume structured session events through the [RPC protocol](rpc.md), or embed the [Rust SDK](sdk.md). The [previous UI component guide](https://github.com/second-state/wasmedge-agent/blob/630cb342f419831ac18d74435ba12b4c14b0a81f/packages/coding-agent/docs/tui.md) documents the historical extension interface.
