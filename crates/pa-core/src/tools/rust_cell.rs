//! Bind the fork's WasmEdge executor and host shell to the native agent loop.
//! The helper owns the guest's private pipes and Cargo workspace lease. Only
//! handlers registered for this session can cross from the helper into Rust.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio_util::sync::CancellationToken;

use super::tool_definition::{
    AbortSignal, ExecutionMode, OnUpdate, ToolContentBlock, ToolDefinition, ToolExecutionResult,
    ToolUpdate,
};
use crate::kernel::shared::{HostRequestHandlers, HostRequestPayload};
use crate::session_engine::rlm_host::{resolve_rlm_max_depth, RlmSubagentHost};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    cwd: PathBuf,
    agent_dir: PathBuf,
    artifact_dir: PathBuf,
    persistent: bool,
    depth: u32,
    session_dir: PathBuf,
    tree_id: String,
    skills: Vec<PathBuf>,
    handlers: Vec<String>,
}

pub(crate) struct CellRuntime {
    session: Session,
    registry: HostRequestHandlers,
    subagent_host: Option<Arc<dyn RlmSubagentHost>>,
    session_file: Option<String>,
    ready: Option<crate::kernel::WorkspaceReadyGate>,
    lifetime: CancellationToken,
    admission: tokio::sync::Mutex<()>,
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
                handlers: registry.names().cloned().collect(),
            },
            registry,
            subagent_host,
            session_file,
            ready,
            _temporary: temporary,
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
        let cancelled = async {
            tokio::select! { () = signal.cancelled() => (), () = self.lifetime.cancelled() => () }
        };
        tokio::pin!(cancelled);
        let _permit = tokio::select! { biased; () = &mut cancelled => bail!("tool call cancelled"), lock = self.admission.lock() => lock };
        if let Some(ready) = &self.ready {
            tokio::select! { biased; () = &mut cancelled => bail!("tool call cancelled"), () = ready() => () }
        }
        let worker = worker_path()?;
        let mut child = Command::new("node")
            .arg(&worker)
            .current_dir(&self.session.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("starting Node tool worker {}", worker.display()))?;
        let mut input = child.stdin.take().context("missing tool worker stdin")?;
        let output = child.stdout.take().context("missing tool worker stdout")?;
        // Dropping stdin also cancels the helper if the entire Rust future is dropped.
        let conversation = async {
            let max_depth = self
                .subagent_host
                .as_ref()
                .and_then(|host| host.max_depth())
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
            write_frame(
                &mut input,
                &json!({"tool":name,"id":id,"args":args,"session":self.session,"maxDepth":max_depth}),
            )
            .await?;
            let mut lines = BufReader::new(output).lines();
            let mut pending = FuturesUnordered::new();
            let mut active = std::collections::HashMap::new();
            loop {
                tokio::select! {
                    line = lines.next_line() => {
                        let line = line?.context("tool worker exited before returning a result")?;
                        match serde_json::from_str::<Event>(&line).context("invalid tool worker event")? {
                            Event::Result { result } => return Ok(result),
                            Event::Error { message } => bail!("{message}"),
                            Event::Update { update } => if let Some(notify) = &updates {
                                notify(ToolUpdate { content: update.content, details: update.details });
                            },
                            Event::Request { id, method, mut payload } => {
                                let (handle, registration) = futures::future::AbortHandle::new_pair();
                                active.insert(id, handle);
                                let handler = self.registry.get(&method).cloned();
                                let dispatch = async move {
                                    let handler = handler.with_context(|| format!("unknown host request {method}"))?;
                                    let fields = payload.as_object_mut().context("expected a host request object")?;
                                    fields.insert("type".into(), Value::String(method));
                                    PARENT_CELL.scope(self.session.clone(), handler(HostRequestPayload { data: payload })).await
                                };
                                pending.push(async move { (id, futures::future::Abortable::new(dispatch, registration).await) });
                            },
                            Event::CancelRequest { id } => if let Some(handle) = active.remove(&id) { handle.abort(); },
                        }
                    },
                    Some((id, response)) = pending.next(), if !pending.is_empty() => {
                        active.remove(&id);
                        if let Ok(response) = response {
                            let reply = match response {
                                Ok(value) => json!({"id":id,"value":value}),
                                Err(error) => json!({"id":id,"error":error.to_string()}),
                            };
                            write_frame(&mut input, &reply).await?;
                        }
                    }
                }
            }
        };
        let result = tokio::select! { biased; () = &mut cancelled => Err(anyhow!("tool call cancelled")), result = conversation => result };
        drop(input);
        let status = child.wait().await?;
        let result = result?;
        anyhow::ensure!(status.success(), "tool worker exited with {status}");
        Ok(result)
    }
}

#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum Event {
    Update {
        update: Update,
    },
    Result {
        result: ToolExecutionResult,
    },
    Error {
        message: String,
    },
    Request {
        id: u64,
        #[serde(rename = "type")]
        method: String,
        payload: Value,
    },
    CancelRequest {
        id: u64,
    },
}

#[derive(Deserialize)]
struct Update {
    content: Vec<ToolContentBlock>,
    details: Option<Value>,
}

async fn write_frame(input: &mut ChildStdin, frame: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(frame)?;
    bytes.push(b'\n');
    input.write_all(&bytes).await?;
    Ok(())
}

tokio::task_local! { static PARENT_CELL: Session; }

/// Freeze the active parent cell's library and dependencies before publishing a child.
/// Spawns outside a cell have no guest workspace to inherit.
pub async fn prepare_child_workspace(child_dir: &Path) -> Result<()> {
    let Ok(parent) = PARENT_CELL.try_with(Clone::clone) else {
        return Ok(());
    };
    tokio::fs::create_dir_all(child_dir).await?;
    let mut child = Command::new("node")
        .arg(worker_path()?)
        .arg("--snapshot")
        .arg(&parent.artifact_dir)
        .arg(&parent.session_dir)
        .arg(child_dir)
        .stdin(Stdio::piped())
        .spawn()?;
    // An abandoned spawn closes this pipe and cancels the staged copy.
    let control = child.stdin.take();
    let status = child.wait().await?;
    drop(control);
    anyhow::ensure!(
        status.success(),
        "child workspace snapshot failed ({status})"
    );
    tokio::fs::write(child_dir.join(".cell-tree-id"), parent.tree_id.to_string()).await?;
    Ok(())
}

pub fn worker_path() -> Result<PathBuf> {
    let packaged = crate::packages::package_dir().join("dist/native-tool-worker.js");
    if packaged.is_file() {
        return Ok(packaged);
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/coding-agent/dist/native-tool-worker.js");
    if std::env::var_os("PI_PACKAGE_DIR").is_none() && source.is_file() {
        return Ok(source);
    }
    bail!("WasmEdge tool worker is missing at {}. Build it with npm run build:tools or reinstall the package.", packaged.display())
}
