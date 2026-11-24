//! Embed the same session engine, provider adapters and WasmEdge tools as the CLI.
//!
//! ```no_run
//! # async fn example(model: wasmedge_agent_sdk::agent_types::Model, stream: wasmedge_agent_sdk::stream::StreamFn) -> Result<(), Box<dyn std::error::Error>> {
//! use wasmedge_agent_sdk::{create_session, SessionEngineConfig};
//! let session = create_session(SessionEngineConfig {
//!     model: Some(model),
//!     stream_fn: Some(stream),
//!     cwd: std::env::current_dir()?,
//!     agent_dir: std::path::PathBuf::from("/path/to/agent-directory"),
//!     daemonless: true,
//!     ..Default::default()
//! }).await?;
//! session.dispose_kernel().await;
//! # Ok(()) }
//! ```
//!
//! Supply a model and stream function to send prompts. A custom session manager
//! enables persistence. Hosts can also install their own tools and guest request handlers.

pub use pa_agent::{agent, scripted::ScriptedProvider, stream, types as agent_types};
pub use pa_ai as providers;
pub use pa_core::kernel::shared::{HostRequestHandlers, HostRequestPayload};
pub use pa_core::session::manager::SessionManager;
pub use pa_core::session_engine::engine::{create_session, SessionEngine, SessionEngineConfig};
pub use pa_core::session_engine::provider_adapter::{
    real_stream_fn, switchable_stream_fn, ProviderTarget,
};
pub use pa_core::session_engine::tool_bridge::bridge_tool;
pub use pa_core::session_engine::{AgentSession, PromptOptions, PromptOutcome};
pub use pa_core::{
    auth, models, settings, skills, AbortSignal, ToolDefinition, ToolExecutionResult,
};
pub use pa_types as types;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn embedding_creates_and_disposes_a_native_session() {
        let project = tempfile::tempdir().unwrap();
        let agent = tempfile::tempdir().unwrap();
        let model = agent_types::Model {
            id: "embedded".into(),
            name: "Embedded".into(),
            api: "test".into(),
            provider: "test".into(),
            base_url: String::new(),
            reasoning: false,
            cost: Default::default(),
            context_window: 8192,
            max_tokens: 512,
            max_tokens_explicit: false,
        };
        let provider = Arc::new(pa_agent::scripted::ScriptedProvider::new(model.clone()));
        provider.push_text_turn("Embedded response");
        let session = create_session(SessionEngineConfig {
            model: Some(model),
            stream_fn: Some(provider.stream_fn()),
            cwd: project.path().to_owned(),
            agent_dir: agent.path().to_owned(),
            daemonless: true,
            ..Default::default()
        })
        .await
        .unwrap();
        session
            .prompt("Hello", PromptOptions::default())
            .await
            .unwrap();
        session.dispose_kernel().await;
    }
}
