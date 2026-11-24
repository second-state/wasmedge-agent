# Rust SDK

The `wasmedge-agent-sdk` crate exposes the session engine used by the native CLI. Use a path dependency from a versioned SDK release, or pin the Git repository to the tag or commit used for your CLI.

```toml
[dependencies]
wasmedge-agent-sdk = { path = "../wasmedge-agent-sdk-X.Y.Z/crates/wasmedge-agent-sdk" }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

## Create a session

The host supplies the model, its stream implementation, and the directories the session can use. This example takes an already configured model. `ScriptedProvider` provides a local stream for integration tests. For a network provider, configure a `ProviderTarget` and use `real_stream_fn`.

```rust
use std::path::PathBuf;
use wasmedge_agent_sdk::{
    agent_types::Model, create_session, stream::StreamFn, PromptOptions, SessionEngineConfig,
};

async fn run(model: Model, stream: StreamFn, data_dir: PathBuf)
    -> Result<(), Box<dyn std::error::Error>>
{
    let engine = create_session(SessionEngineConfig {
        model: Some(model),
        stream_fn: Some(stream),
        cwd: std::env::current_dir()?,
        agent_dir: data_dir,
        daemonless: true,
        ..Default::default()
    }).await?;
    let result = engine.prompt("Summarize this project", PromptOptions::default()).await;
    engine.dispose_kernel().await;
    result?;
    Ok(())
}
```

Run `cargo doc -p wasmedge-agent-sdk --open` in the source workspace for the public interfaces. `SessionManager` controls transcript persistence. `ToolDefinition`, `bridge_tool` and `HostRequestHandlers` expose the tool and guest request interfaces. To execute Rust cells in a deployed embedding, ship the archive's `wasmedge-agent-runtime/template` with your application and point `WASMEDGE_AGENT_TEMPLATE_DIR` at it. Provide Cargo, its `wasm32-wasip1` target, Git and the WasmEdge CLI.

## Migrating from npm

The release asset `wasmedge-agent-sdk-X.Y.Z.tar.gz` contains the Cargo workspace, lockfile, guest runtime and bundled catalogs. The native release workflow publishes it on GitHub Releases. An existing JavaScript application can invoke `wasmedge-agent --mode rpc` as a subprocess. For in-process use, port model selection, session creation, tool registration and event handling to the Rust APIs above. Changes to a Rust session's working directory or agent directory affect the same tools and state as in the CLI. See the [RPC protocol](rpc.md) for the process API.
