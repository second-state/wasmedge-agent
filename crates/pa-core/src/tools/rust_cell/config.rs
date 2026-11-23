use super::Session;
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Limits {
    pub memory_max_mb: Option<u32>,
    pub cpu_quota_percent: Option<u32>,
    pub tasks_max: Option<u32>,
}
impl Limits {
    pub(super) fn active(&self) -> bool {
        self.memory_max_mb.is_some() || self.cpu_quota_percent.is_some() || self.tasks_max.is_some()
    }
    fn check(&self) -> Result<()> {
        ensure!(
            self.memory_max_mb != Some(0)
                && self
                    .cpu_quota_percent
                    .is_none_or(|n| (1..=100_000).contains(&n))
                && self.tasks_max.is_none_or(|n| (1..=4_194_304).contains(&n)),
            "invalid rustCell process limits"
        );
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Config {
    pub cell_timeout_ms: Option<u64>,
    pub cell_gas_limit: Option<u32>,
    pub cell_memory_page_limit: Option<u32>,
    pub runtime_mode: Option<String>,
    pub cargo_sandbox: Option<String>,
    pub workspace_write_policy: Option<String>,
    pub process_limits: Option<Limits>,
    pub tree_process_limits: Option<Limits>,
    pub library_test_gate: bool,
    pub prelude_extra: Vec<serde_json::Value>,
    pub rustdoc_toolchain: Option<String>,
}
impl Config {
    pub fn load(session: &Session) -> Result<Self> {
        let settings = crate::settings::SettingsManager::create(&session.cwd, &session.agent_dir);
        let conf: Self = settings
            .settings()
            .extra
            .get("rustCell")
            .filter(|v| !v.is_null())
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .context("invalid rustCell settings")?
            .unwrap_or_default();
        ensure!(
            matches!(
                conf.runtime_mode.as_deref(),
                None | Some("interpreter" | "aot")
            ),
            "invalid rustCell.runtimeMode"
        );
        ensure!(
            matches!(
                conf.workspace_write_policy.as_deref(),
                None | Some("rw" | "ro")
            ),
            "invalid rustCell.workspaceWritePolicy"
        );
        ensure!(
            matches!(
                conf.cargo_sandbox.as_deref(),
                None | Some("off" | "bubblewrap")
            ),
            "invalid rustCell.cargoSandbox"
        );
        ensure!(
            !conf.bwrap() || cfg!(target_os = "linux"),
            "Bubblewrap requires Linux"
        );
        ensure!(
            conf.cell_gas_limit != Some(0)
                && conf
                    .cell_memory_page_limit
                    .is_none_or(|n| (1..=65_536).contains(&n)),
            "invalid WasmEdge resource limits"
        );
        for limits in [
            conf.process_limits.as_ref(),
            conf.tree_process_limits.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            limits.check()?;
            ensure!(
                !limits.active() || conf.bwrap(),
                "process limits require the Linux Bubblewrap sandbox"
            );
        }
        Ok(conf)
    }
    pub fn timeout(&self) -> std::time::Duration {
        std::time::Duration::from_millis(
            self.cell_timeout_ms
                .filter(|n| *n >= 1000)
                .unwrap_or(120_000),
        )
    }
    pub fn bwrap(&self) -> bool {
        self.cargo_sandbox.as_deref() == Some("bubblewrap")
    }
    pub fn readonly(&self) -> bool {
        self.workspace_write_policy.as_deref() == Some("ro")
    }
    pub fn aot(&self) -> bool {
        self.runtime_mode.as_deref() == Some("aot")
    }
    pub fn wasm_args(&self) -> Vec<String> {
        let mut args = vec!["run".into()];
        if let Some(n) = self.cell_gas_limit {
            args.extend(["--gas-limit".into(), n.to_string()]);
        }
        if let Some(n) = self.cell_memory_page_limit {
            args.extend(["--memory-page-limit".into(), n.to_string()]);
        }
        args
    }
}
pub fn program(name: &str, setting: &str) -> PathBuf {
    if let Some(path) = std::env::var_os(setting).filter(|s| !s.is_empty()) {
        return PathBuf::from(path);
    }
    let exe = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let user = pa_types::platform::home_dir();
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.join(&exe))
        .chain(user.iter().flat_map(|p| {
            [
                p.join(".cargo/bin").join(&exe),
                p.join(".wasmedge/bin").join(&exe),
            ]
        }))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(exe))
}
pub fn template() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("WASMEDGE_AGENT_TEMPLATE_DIR") {
        let path = PathBuf::from(path);
        ensure!(
            path.join("Cargo.toml").is_file(),
            "missing configured template at {}",
            path.display()
        );
        return Ok(path);
    }
    let package = crate::packages::package_dir();
    for root in [
        package.clone(),
        package.join("dist"),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."),
    ] {
        let path = root.join("wasmedge-agent-runtime/template");
        if path.join("Cargo.toml").is_file() {
            return Ok(path);
        }
    }
    bail!("missing wasmedge-agent-runtime/template")
}
