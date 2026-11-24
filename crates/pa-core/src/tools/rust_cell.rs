//! WasmEdge cell execution inside the native session worker.
mod bridge;
mod config;
mod dependencies;
mod guest;
mod harness;
mod host;
mod introspection;
pub mod maintenance;
mod process;
mod rustdoc;
mod sandbox;
mod shell;
mod skills;
mod upgrade;
mod wasm;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::tool_definition::{
    AbortSignal, ExecutionMode, OnUpdate, ToolDefinition, ToolExecutionResult,
};
use crate::kernel::shared::HostRequestHandlers;
use crate::session_engine::rlm_host::{resolve_rlm_max_depth, RlmSubagentHost};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct Session {
    cwd: PathBuf,
    agent_dir: PathBuf,
    artifact_dir: PathBuf,
    persistent: bool,
    depth: u32,
    session_dir: PathBuf,
    tree_id: String,
    skills: Vec<PathBuf>,
}

pub(crate) struct CellRuntime {
    session: Session,
    registry: HostRequestHandlers,
    subagent_host: Option<Arc<dyn RlmSubagentHost>>,
    session_file: Option<String>,
    ready: Option<crate::kernel::WorkspaceReadyGate>,
    lifetime: CancellationToken,
    admission: tokio::sync::Mutex<()>,
    versions: tokio::sync::OnceCell<(String, String)>,
    _temporary: Option<tempfile::TempDir>,
}

impl CellRuntime {
    pub(crate) fn new(
        cwd: PathBuf,
        agent_dir: PathBuf,
        artifacts: Option<PathBuf>,
        session_dir: PathBuf,
        depth: u32,
        skills: &[crate::skills::Skill],
        registry: HostRequestHandlers,
        ready: Option<crate::kernel::WorkspaceReadyGate>,
        subagent_host: Option<Arc<dyn RlmSubagentHost>>,
        session_file: Option<String>,
    ) -> Result<Self> {
        let temporary = artifacts.is_none().then(tempfile::tempdir).transpose()?;
        let persistent = artifacts.is_some();
        let artifact_dir = artifacts.unwrap_or_else(|| {
            temporary
                .as_ref()
                .expect("ephemeral session")
                .path()
                .to_owned()
        });
        let tree_id = if depth == 0 {
            uuid::Uuid::new_v4()
        } else {
            match std::fs::read_to_string(session_dir.join(".cell-tree-id")) {
                Ok(id) => {
                    uuid::Uuid::parse_str(id.trim()).context("invalid parent cell tree id")?
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => uuid::Uuid::new_v4(),
                Err(err) => return Err(err.into()),
            }
        };
        Ok(Self {
            session: Session {
                cwd,
                agent_dir,
                artifact_dir,
                persistent,
                depth,
                session_dir,
                tree_id: tree_id.to_string(),
                skills: skills.iter().map(|skill| skill.file_path.clone()).collect(),
            },
            registry,
            subagent_host,
            session_file,
            ready,
            _temporary: temporary,
            versions: Default::default(),
            lifetime: CancellationToken::new(),
            admission: tokio::sync::Mutex::new(()),
        })
    }

    pub(crate) async fn drain(&self) {
        drop(self.admission.lock().await);
    }

    pub(crate) async fn test_skill(
        &self,
        reference: &serde_json::Map<String, Value>,
    ) -> Result<()> {
        self.execute(
            "testSkill",
            "refine",
            json!({ "reference": reference }),
            AbortSignal::default(),
            None,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn dispose(&self) {
        self.lifetime.cancel();
        drop(self.admission.lock().await);
    }

    pub(crate) fn tool(self: &Arc<Self>, name: &'static str) -> ToolDefinition {
        let (description, parameters) = if name == "rust" {
            ("Compile a complete Rust program to wasm32-wasip1 and execute it in WasmEdge. Optional lib edits extend agent_lib and roll back on a failed build. Return stdout, rustc diagnostics and attachments.", json!({
                "type":"object", "properties":{"code":{"type":"string"},
                "lib":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}}}, "required":["code"]
            }))
        } else {
            ("Run a command on the host in the project directory. Returns stdout and stderr. Timeout is in seconds.", json!({
                "type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"number"},"allowDestructiveGit":{"type":"boolean"}},"required":["command"]
            }))
        };
        let runtime = Arc::downgrade(self);
        ToolDefinition {
            name: name.to_owned(),
            label: name.to_owned(),
            description: description.to_owned(),
            prompt_snippet: description.to_owned(),
            parameters,
            execution_mode: Some(ExecutionMode::Sequential),
            prepare_arguments: None,
            execute: Arc::new(move |id, args, signal, updates| {
                let runtime = runtime.upgrade();
                let id = id.to_owned();
                Box::pin(async move {
                    runtime
                        .context("session closed")?
                        .execute(name, &id, args, signal.unwrap_or_default(), updates)
                        .await
                })
            }),
        }
    }

    async fn execute(
        &self,
        name: &str,
        id: &str,
        args: Value,
        signal: AbortSignal,
        updates: Option<OnUpdate>,
    ) -> Result<ToolExecutionResult> {
        let entered = std::time::Instant::now();
        let cancelled = async {
            tokio::select! { () = signal.cancelled() => (), () = self.lifetime.cancelled() => () }
        };
        tokio::pin!(cancelled);
        let _permit = tokio::select! { biased; () = &mut cancelled => bail!("tool call cancelled"), lock = self.admission.lock() => lock };
        let queue = entered.elapsed();
        if let Some(ready) = &self.ready {
            tokio::select! { biased; () = &mut cancelled => bail!("tool call cancelled"), () = ready() => () }
        }
        let run = async {
            if name == "bash" {
                return shell::execute(&self.session, &args, updates.as_ref()).await;
            }
            let config = config::Config::load(&self.session)?;
            let work = async {
                let ws = self.session.artifact_dir.join("workspace");
                let _lease = workspace::acquire(&ws).await?;
                upgrade::recover(&ws)?;
                let template = config::template()?;
                maintenance::prepare_template(&template, false).await?;
                let resources = sandbox::Resources::new(&self.session, &config)?;
                let max_depth = self
                    .subagent_host
                    .as_ref()
                    .and_then(|h| h.max_depth())
                    .map_or_else(
                        || {
                            resolve_rlm_max_depth(
                                self.session_file.as_deref(),
                                None,
                                &self.session.cwd,
                                &self.session.agent_dir,
                            )
                            .0
                        },
                        u64::from,
                    );
                let guest = guest::Guest {
                    runtime: self,
                    ws: &ws,
                    config: &config,
                    resources: &resources,
                    max_depth,
                };
                upgrade::prepare(&guest, &template).await?;
                skills::sync(&self.session, &ws)?;
                host::configure(&guest).await?;
                if name == "testSkill" {
                    skills::test_reference(&guest, &args["reference"]).await?;
                    return Ok(ToolExecutionResult::text("Skill tests passed"));
                }
                let provision = entered.elapsed().saturating_sub(queue);
                let mut output = guest.execute(id, &args, updates.as_ref()).await?;
                if let Some(d) = output.details.as_mut() {
                    d["toolTiming"] = json!({"provisionMs":provision.as_secs_f64()*1000.0,"totalMs":entered.elapsed().as_secs_f64()*1000.0});
                    d["timings"]["queueMs"] = json!(queue.as_secs_f64() * 1000.0);
                }
                Ok(output)
            };
            tokio::time::timeout(config.timeout(), work)
                .await
                .context("Rust cell timed out")?
        };
        tokio::select! { biased; () = &mut cancelled => bail!("tool call cancelled"), result = run => result }
    }
}

tokio::task_local! { static PARENT_CELL: Session; }

/// Freeze the active parent cell's library and dependencies before publishing a child.
/// Spawns outside a cell have no guest workspace to inherit.
pub async fn prepare_child_workspace(child_dir: &Path) -> Result<()> {
    let Ok(parent) = PARENT_CELL.try_with(Clone::clone) else {
        return Ok(());
    };
    tokio::fs::create_dir_all(child_dir).await?;
    if let Some(source) = [
        parent.artifact_dir.join("workspace"),
        parent.session_dir.join(workspace::SEED),
    ]
    .into_iter()
    .find(|path| path.join("Cargo.toml").is_file())
    {
        workspace::snapshot(&source, &child_dir.join(workspace::SEED))?;
    }
    workspace::atomic(&child_dir.join(".cell-tree-id"), parent.tree_id.as_bytes())
}
