//! Compose session-scoped handlers for the guest host bridge.

use super::runtime::QueuedGoalContextPurge;
use crate::kernel::shared::HostRequestHandlers;
use crate::session::manager::SessionManager;
use crate::skills::Skill;
use std::sync::Arc;

use super::host_requests::SessionBinding;
use super::rlm_host::{register_rlm_host_handlers, RlmHostBridge, RlmSubagentHost};
use super::runtime::SessionRuntime;

/// RLM inputs the session composition supplies: a shared model registry and the daemon
/// child-session host; defaults derive from `agent_dir` or the no-children behavior.
#[derive(Default)]
pub struct RlmWiring {
    /// Registry `rlm.find_models` searches. Defaults to the `agent_dir` catalog.
    pub model_registry: Option<Arc<crate::models::registry::ModelRegistry>>,
    /// Child-session machinery backing `rlm.spawn`/`rlm.create_session` and
    /// the roster/collect/delete surface.
    pub subagent_host: Option<Arc<dyn RlmSubagentHost>>,
    pub usage_store: Option<Arc<dyn super::rlm_usage::RlmChildUsageStore>>,
    /// Announces every accepted `rlm.progress.note`; `None` keeps the store
    /// the only surface.
    pub progress_note_emit: Option<super::rlm_host::RlmProgressNoteEmit>,
    /// The daemon-owned agent inbox whose `rlm.inbox.*` host requests
    /// register here; `None` (daemonless) keeps the requests unregistered.
    pub inbox: Option<Arc<super::inbox::SessionInbox>>,
}

/// The embedding's cron wiring for the kernel's `rlm_heartbeat.*` host
/// requests: the shared store plus the durable session identity the
/// kernel-created jobs bind to.
#[derive(Clone)]
pub struct KernelCronWiring {
    /// The daemon worker's scheduled-jobs store.
    pub store: std::sync::Arc<crate::cron::store::AgentCronJobStore>,
    /// `None` until the embedding knows it (the engine falls back to the
    /// in-memory manager's identity).
    pub binding: Option<KernelCronBinding>,
    /// The post-mutation seam for kernel `rlm_heartbeat.*` requests;
    /// `None` leaves mutations unannounced (the embedded default).
    pub mutation_hook: Option<super::host_requests::RlmHeartbeatMutationHook>,
}

/// The live/durable session identity for kernel-created rlm heartbeats.
#[derive(Clone, Debug)]
pub struct KernelCronBinding {
    /// The live active session id the daemon routes commands by.
    pub active_session_id: String,
    /// The durable session id the store partitions by.
    pub session_id: String,
    /// The durable session file the rebind pass moves jobs through.
    pub session_file: String,
    /// The session working directory.
    pub cwd: String,
}

// Opaque like the store it carries: the store handle has no meaningful
// debug form, and config structs embedding the wiring derive `Debug`.
impl std::fmt::Debug for KernelCronWiring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KernelCronWiring")
            .field("binding", &self.binding)
            // `..` documents the deliberately-opaque store + hook.
            .finish_non_exhaustive()
    }
}

/// Session-scoped runtime wiring: the shared session manager handle,
/// the kernel host-handler registry, and the runtime itself.
pub struct SessionKernelWiring {
    pub session: Arc<tokio::sync::Mutex<SessionManager>>,
    pub handlers: HostRequestHandlers,
    pub runtime: Arc<SessionRuntime>,
    /// The RLM bridge: progress-note state the daemon roster reads.
    pub rlm: Arc<RlmHostBridge>,
    /// The child-usage attribution producer the daemon's children
    /// registry drives after the engine is built.
    pub rlm_usage: Arc<super::rlm_usage::RlmChildUsageAttributions>,
}

/// Build the session runtime and register the `goal.*`, `rlm.*`, the
/// `rlm.inbox.*` requests when an inbox store is supplied, and — only
/// when `cron_store` wiring exists — the `rlm_heartbeat.*` host
/// handlers; `goal_complete_purge` is the embedding's queued-goal-context purge.
#[must_use]
pub fn wire_session_runtime(
    session: SessionManager,
    agent_dir: &std::path::Path,
    rlm: RlmWiring,
    goal_complete_purge: Option<QueuedGoalContextPurge>,
    cron_store: Option<KernelCronWiring>,
) -> SessionKernelWiring {
    // The embedding's durable session identity overrides the in-memory manager's
    // when supplied: kernel-created rlm heartbeats must bind the live session id the
    // supervisor routes by, plus the durable id + file (the partition the store writes
    // and the rebind pass moves onto live sessions).
    let fallback_binding = || {
        (
            session.get_session_id().to_string(),
            SessionBinding {
                session_id: session.get_session_id().to_string(),
                session_file: session
                    .get_session_file()
                    .map(|path| path.display().to_string())
                    .unwrap_or_default(),
                cwd: session.get_cwd().display().to_string(),
            },
        )
    };
    let (active_session_id, binding) = match cron_store
        .as_ref()
        .and_then(|wiring| wiring.binding.as_ref())
    {
        Some(binding) => (
            binding.active_session_id.clone(),
            SessionBinding {
                session_id: binding.session_id.clone(),
                session_file: binding.session_file.clone(),
                cwd: binding.cwd.clone(),
            },
        ),
        None => fallback_binding(),
    };
    // An embedding-owned store, so kernel `rlm_heartbeat.*` writes reach
    // the daemon catalog. Kernel heartbeat requests need the embedding's
    // scheduler to fire the jobs they create: without cron wiring they
    // stay unregistered (TS registers only with the heartbeat controller).
    let mutation_hook = cron_store
        .as_ref()
        .and_then(|wiring| wiring.mutation_hook.clone());
    let cron_store = cron_store.map(|wiring| wiring.store);
    let mut runtime = SessionRuntime::new(&session, cron_store, active_session_id, binding);
    if let Some(purge) = goal_complete_purge {
        runtime.set_goal_complete_purge(purge);
    }
    if let Some(hook) = mutation_hook {
        runtime.set_cron_mutation_hook(hook);
    }
    let runtime = Arc::new(runtime);
    let session = Arc::new(tokio::sync::Mutex::new(session));
    let mut handlers = HostRequestHandlers::default();
    runtime.register_host_handlers(session.clone(), &mut handlers);
    let model_registry = rlm.model_registry.unwrap_or_else(|| {
        let auth = crate::auth::AuthStorage::create(agent_dir);
        Arc::new(crate::models::registry::ModelRegistry::create(
            auth,
            agent_dir.join("models.json"),
        ))
    });
    let rlm_usage = Arc::new(super::rlm_usage::RlmChildUsageAttributions::new(
        rlm.usage_store
            .unwrap_or_else(|| Arc::new(super::rlm_usage::SessionUsageStore(session.clone()))),
    ));
    // The daemon supplies the child-session host; an embedding without
    // one keeps the no-children behavior, whose self-rename appends the
    // session's own `session_info` name row.
    let subagent_host = rlm
        .subagent_host
        .unwrap_or_else(|| Arc::new(super::rlm_host::NoRlmChildren::new(session.clone())));
    let rlm_bridge = Arc::new(RlmHostBridge::new(
        model_registry,
        subagent_host,
        rlm_usage.clone(),
        rlm.progress_note_emit,
    ));
    register_rlm_host_handlers(&mut handlers, &rlm_bridge);
    if let Some(inbox) = &rlm.inbox {
        super::inbox::register_inbox_host_handlers(inbox, &mut handlers);
    }
    SessionKernelWiring {
        session,
        handlers,
        runtime,
        rlm: rlm_bridge,
        rlm_usage,
    }
}

/// Bundled skills whose kernel host requests are controller-backed: the
/// skill is model-visible only when its host request is registered (the
/// registry decides, like TS `_modelVisibleSkills` reads its controllers).
const CONTROLLER_BACKED_SKILLS: [(&str, &str); 3] = [
    // skills/agent-message sends `agent_message.send`.
    ("agent-message", "agent_message.send"),
    // skills/agent-observe sends `agent_observe.list`.
    ("agent-observe", "agent_observe.list"),
    // skills/rlm-heartbeat sends `rlm_heartbeat.create`.
    ("rlm-heartbeat", "rlm_heartbeat.create"),
];

/// The model-visible skill list for a final host-handler registry: a
/// controller-backed bundled skill whose host request is not registered
/// (print/RPC builds without that wiring) drops out.
#[must_use]
pub fn model_visible_skills(skills: Vec<Skill>, handlers: &HostRequestHandlers) -> Vec<Skill> {
    skills
        .into_iter()
        .filter(|skill| {
            !CONTROLLER_BACKED_SKILLS
                .iter()
                .any(|(name, request)| skill.name == *name && handlers.get(request).is_none())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::store::AgentCronJobStore;
    use crate::kernel::shared::{host_handler, HostRequestHandlers};
    use serde_json::Value;

    fn cron_wiring(dir: &std::path::Path) -> KernelCronWiring {
        KernelCronWiring {
            store: Arc::new(AgentCronJobStore::new(dir.join("jobs.json"))),
            binding: None,
            mutation_hook: None,
        }
    }

    /// An engine build without cron wiring (print/RPC) serves no
    /// `rlm_heartbeat.*` requests: no scheduler fires the jobs they create.
    #[test]
    fn without_cron_wiring_the_rlm_heartbeat_handlers_stay_unregistered() {
        let dir = tempfile::tempdir().unwrap();
        let session = SessionManager::in_memory(dir.path());
        let wiring = wire_session_runtime(session, dir.path(), RlmWiring::default(), None, None);
        assert!(wiring.handlers.get("rlm_heartbeat.create").is_none());
        assert!(wiring.handlers.get("rlm_heartbeat.list").is_none());
        // The goal surface needs no scheduler and stays registered.
        assert!(wiring.handlers.get("goal.get").is_some());
    }

    #[test]
    fn with_cron_wiring_the_rlm_heartbeat_handlers_register() {
        let dir = tempfile::tempdir().unwrap();
        let session = SessionManager::in_memory(dir.path());
        let wiring = wire_session_runtime(
            session,
            dir.path(),
            RlmWiring::default(),
            None,
            Some(cron_wiring(dir.path())),
        );
        assert!(wiring.handlers.get("rlm_heartbeat.create").is_some());
    }

    fn skill_named(name: &str) -> crate::skills::Skill {
        use crate::skills::{create_synthetic_source_info, SkillKind, SourceScope};
        crate::skills::Skill {
            name: name.to_string(),
            description: "a skill".to_string(),
            file_path: std::path::PathBuf::from("/skills/SKILL.md"),
            base_dir: std::path::PathBuf::from("/skills"),
            source_info: create_synthetic_source_info("/skills", "user", SourceScope::User, None),
            disable_model_invocation: false,
            kind: SkillKind::Markdown,
            python: None,
        }
    }

    /// A controller-backed bundled skill whose host request is not
    /// registered drops out; the registered ones and plain skills stay.
    #[test]
    fn model_visible_skills_follow_the_handler_registry() {
        let skills = vec![
            skill_named("agent-message"),
            skill_named("agent-observe"),
            skill_named("rlm-heartbeat"),
            skill_named("websearch"),
        ];
        let mut handlers = HostRequestHandlers::default();
        handlers.register(
            "agent_message.send",
            host_handler(|_payload| Box::pin(async { Ok(Value::Null) })),
        );
        let visible = model_visible_skills(skills, &handlers);
        let names: Vec<&str> = visible.iter().map(|skill| skill.name.as_str()).collect();
        assert_eq!(names, ["agent-message", "websearch"]);

        handlers.register(
            "agent_observe.list",
            host_handler(|_payload| Box::pin(async { Ok(Value::Null) })),
        );
        handlers.register(
            "rlm_heartbeat.create",
            host_handler(|_payload| Box::pin(async { Ok(Value::Null) })),
        );
        let visible = model_visible_skills(
            vec![
                skill_named("agent-message"),
                skill_named("agent-observe"),
                skill_named("rlm-heartbeat"),
            ],
            &handlers,
        );
        assert_eq!(visible.len(), 3);
    }
}
