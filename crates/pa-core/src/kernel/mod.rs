//! Shared host request protocol, process journal and RLM model selection.
pub mod cancellation;
pub mod orphan_journal;
pub mod rlm_runtime;
pub mod shared;

pub type WorkspaceReadyGate =
    std::sync::Arc<dyn Fn() -> futures::future::BoxFuture<'static, ()> + Send + Sync>;

pub use cancellation::AbortSignal;
pub use rlm_runtime::{
    create_default_rlm_subagent_session_name, find_rlm_model_matches,
    find_unique_rlm_short_form_model_match, format_rlm_model_unavailable_error,
    normalize_requested_rlm_subagent_model, normalize_requested_rlm_subagent_session_name,
    normalize_requested_rlm_subagent_thinking_level, RlmModelInfo, RlmModelMatch, THINKING_LEVELS,
};
pub use shared::{
    HostRequestHandler, HostRequestHandlers, HostRequestPayload, KernelDiffDisplay,
    KernelSentAgentMessage, StreamName, EXECUTE_STATUS_ABORTED, EXECUTE_STATUS_ERROR,
    EXECUTE_STATUS_OK,
};
