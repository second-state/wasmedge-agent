use super::{
    bridge, config, host, process, sandbox, skills, wasm, workspace, CellRuntime, OnUpdate,
    ToolExecutionResult,
};
use crate::tools::tool_definition::ToolContentBlock;
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{fs, path::Path, time::Instant};

pub(super) struct Guest<'a> {
    pub runtime: &'a CellRuntime,
    pub ws: &'a Path,
    pub config: &'a config::Config,
    pub resources: &'a sandbox::Resources,
    pub max_depth: u64,
}
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Timings {
    version: u8,
    queue_ms: f64,
    prepare_ms: f64,
    skill_validation_ms: f64,
    library_tests_ms: f64,
    build_queue_ms: f64,
    cargo_ms: f64,
    rollback_ms: f64,
    import_policy_ms: f64,
    probe_ms: f64,
    aot_compile_ms: f64,
    execution_ms: f64,
    bridge_cleanup_ms: f64,
    snapshot_ms: f64,
    other_ms: f64,
}
fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
impl Guest<'_> {
    pub async fn execute(
        &self,
        id: &str,
        args: &Value,
        updates: Option<&OnUpdate>,
    ) -> Result<ToolExecutionResult> {
        let start = Instant::now();
        let code = args["code"]
            .as_str()
            .context("Rust cell requires source code")?;
        let edits = match args.get("lib") {
            Some(v) => v.as_array().context("lib must be an array")?.as_slice(),
            None => &[],
        };
        let mode = if self.config.aot() {
            "aot"
        } else {
            "interpreter"
        };
        let mut details = json!({"runtimeMode":mode,"libApplied":false,"libReverted":false,"libReadonlyFallback":false,
            "status":"ok","stdout":"","stderr":"","attachments":[],"diffs":[],"sentAgentMessages":[],"runMs":0,"compileMs":0});
        let mut timings = Timings {
            version: 1,
            ..Default::default()
        };
        let phase = Instant::now();
        host::revalidate(self).await?;
        timings.skill_validation_ms = elapsed(phase);
        let mut change = workspace::Changes::new();
        let build = async {
            if self.config.library_test_gate && !edits.is_empty() {
                let phase = Instant::now();
                let tests = skills::test(self, "agent_lib", edits).await;
                timings.library_tests_ms = elapsed(phase);
                tests?;
            }
            let diffs = workspace::lib_edits(self.ws, edits, &mut change)?;
            change.write(self.ws.join("cell/src/main.rs"), code.as_bytes())?;
            let args = [
                "build",
                "--release",
                "--offline",
                "--target",
                "wasm32-wasip1",
                "-p",
                "cell",
                "--message-format=json-diagnostic-rendered-ansi",
            ];
            let cmd = sandbox::cargo(self.ws, self.config, self.resources, &args, None)?;
            let phase = Instant::now();
            let build = sandbox::build(cmd).await;
            timings.cargo_ms = elapsed(phase);
            let build = build?;
            let diagnostics = build
                .stdout
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter_map(|v| v["message"]["rendered"].as_str().map(str::to_owned))
                .collect::<Vec<_>>()
                .join("\n");
            ensure!(build.status.success(), "{}{}", build.stderr, diagnostics);
            Ok::<_, anyhow::Error>(diffs)
        }
        .await;
        details["compileMs"] = json!(start.elapsed().as_millis());
        let mut diffs = match build {
            Ok(diffs) => {
                change.commit();
                details["libApplied"] = json!(!edits.is_empty());
                diffs
            }
            Err(e) => {
                let phase = Instant::now();
                drop(change);
                timings.rollback_ms = elapsed(phase);
                details["libReverted"] = json!(!edits.is_empty());
                details["compileDiagnostics"] = json!(e.to_string());
                details["status"] = json!("compile_error");
                return Ok(result(details, start, timings));
            }
        };
        let run = Instant::now();
        match self.run(id, code, updates, &mut timings).await {
            Ok((out, fallback)) => {
                details["stdout"] = json!(out.stdout);
                details["stderr"] = json!(out.stderr);
                details["exitCode"] = json!(out.code);
                if out.code != 0 {
                    details["status"] = json!("error");
                }
                details["libReadonlyFallback"] = json!(fallback);
                diffs.extend(out.display.diffs);
                details["attachments"] = json!(out.display.attachments);
                details["sentAgentMessages"] = json!(out.display.messages);
                if out.code == 0 && self.runtime.session.persistent {
                    let phase = Instant::now();
                    match workspace::history(self.ws, &format!("cell {id}")).await {
                        Ok(commit) => details["workspaceCommit"] = json!(commit),
                        Err(e) => details["workspaceCommitError"] = json!(e.to_string()),
                    }
                    timings.snapshot_ms = elapsed(phase);
                }
            }
            Err(e) => {
                details["status"] = json!("error");
                details["stderr"] = json!(e.to_string());
            }
        }
        details["diffs"] = json!(diffs);
        details["runMs"] = json!(run.elapsed().as_millis());
        Ok(result(details, start, timings))
    }
    async fn run(
        &self,
        id: &str,
        code: &str,
        updates: Option<&OnUpdate>,
        timings: &mut Timings,
    ) -> Result<(bridge::Output, bool)> {
        let prepare = Instant::now();
        let session = &self.runtime.session;
        let ws = self.ws.canonicalize()?;
        let cwd = session.cwd.canonicalize()?;
        let readonly = self.config.readonly();
        let state = ws.join("state");
        fs::create_dir_all(&state)?;
        let scratch_root = ws.join(".scratch");
        fs::create_dir_all(&scratch_root)?;
        let scratch = tempfile::tempdir_in(scratch_root)?;
        let lib = ws.join("agent_lib");
        let mut protected = vec![crate::refinement::get_global_harness_state_dir(
            &session.agent_dir,
        )];
        protected.extend(crate::refinement::get_local_harness_state_dir(
            session.persistent.then_some(&session.artifact_dir),
        ));
        let stores: Vec<_> = protected
            .iter()
            .flat_map(|p| [p.to_owned(), p.join("harness_state.json")])
            .map(|p| workspace::physical(&p))
            .collect::<Result<_>>()?;
        for path in [&cwd, state.as_path(), scratch.path(), lib.as_path()] {
            let physical = path.canonicalize()?;
            ensure!(
                !ambiguous_mount(path) && !ambiguous_mount(&physical),
                "ambiguous WasmEdge preopen path: {}",
                path.display()
            );
            if path == lib || readonly && path == cwd {
                continue;
            }
            ensure!(
                stores.iter().all(|s| !workspace::overlap(&physical, s)),
                "writable mount overlaps a host harness store"
            );
            ensure!(
                !readonly || !workspace::overlap(&physical, &cwd),
                "writable mount overlaps read-only /workspace"
            );
        }
        let dir = tempfile::tempdir()?;
        let exe = config::program("wasmedge", "WASMEDGE_AGENT_WASMEDGE");
        let probe = dir.path().join("probe.wasm");
        fs::write(
            &probe,
            hex::decode(
                "0061736d0100000001040160000003020100070a01065f737461727400000a040102000b",
            )?,
        )?;
        let mut cmd = process::command(&exe, &ws);
        cmd.args(["run", "--force-interpreter", "--dir"])
            .arg(format!("/agent/lib:{}:readonly", lib.display()))
            .arg(probe);
        timings.prepare_ms = elapsed(prepare);
        let phase = Instant::now();
        let probe = process::run(self.resources.wrap(cmd)?, None)
            .await?
            .require("readonly preopen probe")?;
        timings.probe_ms = elapsed(phase);
        let fallback =
            format!("{}{}", probe.stderr, probe.stdout).contains("Bind guest directory failed");
        ensure!(
            !(readonly && fallback),
            "WasmEdge cannot enforce the requested read-only /workspace"
        );
        let phase = Instant::now();
        let module = wasm::prepare(
            &sandbox::target(&ws, self.config).join("wasm32-wasip1/release/cell.wasm"),
            dir.path(),
            self.config,
            self.resources,
            self.config.aot(),
        )
        .await?;
        if self.config.aot() {
            timings.aot_compile_ms = elapsed(phase);
        } else {
            timings.import_policy_ms = elapsed(phase);
        }
        let mut token = [0u8; 32];
        getrandom::fill(&mut token).map_err(|e| anyhow::anyhow!("guest handshake entropy: {e}"))?;
        let token = hex::encode(token);
        let mut cmd = process::command(exe, &ws);
        cmd.args(self.config.wasm_args());
        if !self.config.aot() {
            cmd.arg("--force-interpreter");
        }
        cmd.arg("--dir").arg(format!(
            "/workspace:{}{}",
            cwd.display(),
            if readonly { ":readonly" } else { "" }
        ));
        if !fallback {
            cmd.arg("--dir")
                .arg(format!("/agent/lib:{}:readonly", lib.display()));
        }
        cmd.arg("--dir")
            .arg(format!("/agent/state:{}", state.display()))
            .arg("--dir")
            .arg(format!("/scratch:{}", scratch.path().display()));
        for var in [
            format!("RLM_DEPTH={}", session.depth),
            format!("RLM_MAX_DEPTH={}", self.max_depth),
            "RLM_BRIDGE_STDIO=1".into(),
            format!("RLM_BRIDGE_TOKEN={token}"),
            format!("RLM_CELL_ID={id}"),
            format!("RLM_CELL_TIMEOUT_MS={}", self.config.timeout().as_millis()),
        ] {
            cmd.arg("--env").arg(var);
        }
        cmd.arg(module);
        let phase = Instant::now();
        let output = bridge::run(self.resources.wrap(cmd)?, self, id, code, &token, updates).await;
        timings.execution_ms = elapsed(phase);
        Ok((output?, fallback))
    }
}
fn ambiguous_mount(path: &Path) -> bool {
    let s = path.to_string_lossy();
    #[cfg(windows)]
    let s = s
        .strip_prefix(r"\\?\")
        .unwrap_or(&s)
        .split_once(":\\")
        .map_or(s.as_ref(), |(_, p)| p);
    s.contains(':')
}
fn result(mut details: Value, start: Instant, timings: Timings) -> ToolExecutionResult {
    let duration = elapsed(start);
    let mut timing = json!(timings);
    let measured = timing
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| k.ends_with("Ms"))
        .filter_map(|(_, v)| v.as_f64())
        .sum::<f64>();
    timing["otherMs"] = json!((duration - measured).max(0.0));
    details["durationMs"] = json!(duration);
    details["timings"] = timing;
    let mut text = ["compileDiagnostics", "stdout", "stderr"]
        .iter()
        .filter_map(|s| details[s].as_str())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if let Some(error) = details["workspaceCommitError"].as_str() {
        text.push_str(&format!(
            "\n[cell succeeded but its workspace snapshot failed: {error}]"
        ));
    }
    let mut content = vec![ToolContentBlock::text(if text.is_empty() {
        "(no output)".to_owned()
    } else {
        text
    })];
    for image in details["attachments"].as_array().into_iter().flatten() {
        if let (Some(mime), Some(data)) = (
            image["mimeType"]
                .as_str()
                .filter(|s| s.starts_with("image/")),
            image["data"].as_str(),
        ) {
            content.push(ToolContentBlock::Image {
                mime_type: mime.into(),
                data: data.into(),
            });
        }
    }
    ToolExecutionResult {
        content,
        is_error: details["status"] != "ok",
        details: Some(details),
        terminate: None,
    }
}
