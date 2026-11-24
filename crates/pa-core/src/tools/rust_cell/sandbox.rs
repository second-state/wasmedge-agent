use super::{
    config::{self, Config, Limits},
    process, Session,
};
use anyhow::{anyhow, ensure, Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

fn controls(l: &Limits, scope: bool) -> (Vec<String>, Vec<(String, String)>) {
    let mut props = Vec::new();
    let mut checks = Vec::new();
    if let Some(n) = l.memory_max_mb {
        let bytes = u64::from(n) * 1_048_576;
        props.extend([format!("MemoryMax={bytes}"), "MemorySwapMax=0".into()]);
        checks.extend([
            ("memory.max".into(), bytes.to_string()),
            ("memory.swap.max".into(), "0".into()),
        ]);
        if scope {
            props.push("OOMPolicy=kill".into());
            checks.push(("memory.oom.group".into(), "1".into()));
        }
    }
    if let Some(n) = l.cpu_quota_percent {
        props.extend([format!("CPUQuota={n}%"), "CPUQuotaPeriodSec=100ms".into()]);
        checks.push(("cpu.max".into(), format!("{} 100000", n * 1000)));
    }
    if let Some(n) = l.tasks_max {
        props.push(format!("TasksMax={n}"));
        checks.push(("pids.max".into(), n.to_string()));
    }
    (props, checks)
}
fn user_bus(cmd: &mut std::process::Command) {
    #[cfg(unix)]
    {
        let path = format!("/run/user/{}", crate::platform::process::current_user_id());
        cmd.env("XDG_RUNTIME_DIR", &path)
            .env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={path}/bus"));
    }
    #[cfg(not(unix))]
    let _ = cmd;
}
fn systemctl(args: &[String]) -> Result<()> {
    let mut cmd = std::process::Command::new("/usr/bin/systemctl");
    user_bus(&mut cmd);
    let out = cmd.arg("--user").args(args).stdin(Stdio::null()).output()?;
    ensure!(
        out.status.success(),
        "systemd slice: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(())
}
struct Tree {
    unit: String,
    dir: PathBuf,
    owner: PathBuf,
    _file: fs::File,
}
fn lock_file(path: &Path) -> Result<fs::File> {
    Ok(fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?)
}
fn active(dir: &Path) -> Result<usize> {
    let mut count = 0;
    for file in fs::read_dir(dir)? {
        let p = file?.path();
        if p.extension().is_none_or(|e| e != "owner") {
            continue;
        }
        let f = fs::OpenOptions::new().read(true).write(true).open(&p)?;
        match f.try_lock() {
            Ok(()) => {
                drop(f);
                fs::remove_file(&p)?;
            }
            Err(fs::TryLockError::WouldBlock) => count += 1,
            Err(fs::TryLockError::Error(e)) => return Err(e.into()),
        }
    }
    Ok(count)
}
impl Tree {
    fn open(session: &Session, limits: &Limits) -> Result<Self> {
        let id = uuid::Uuid::parse_str(&session.tree_id)?;
        let unit = format!("app-wasmedge_agent_{}.slice", id.simple());
        let dir = session
            .agent_dir
            .join("cell-process-trees")
            .join(id.to_string() + ".native");
        fs::create_dir_all(&dir)?;
        let lock = lock_file(&dir.join("membership.lock"))?;
        lock.lock()?;
        let store = dir.join("limits.json");
        if active(&dir)? > 0 {
            ensure!(
                serde_json::from_slice::<Limits>(&fs::read(&store)?)? == *limits,
                "active process tree has different limits"
            );
        } else {
            let mut args = vec!["set-property".into(), "--runtime".into(), unit.clone()];
            args.extend(controls(limits, false).0);
            systemctl(&args)?;
            fs::write(&store, serde_json::to_vec(limits)?)?;
        }
        let owner = dir.join(format!("{}.owner", uuid::Uuid::new_v4()));
        let file = lock_file(&owner)?;
        file.lock()?;
        Ok(Self {
            unit,
            dir,
            owner,
            _file: file,
        })
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let cleanup = || -> Result<()> {
            let lock = lock_file(&self.dir.join("membership.lock"))?;
            lock.lock()?;
            fs::remove_file(&self.owner)?;
            if active(&self.dir)? == 0 {
                systemctl(&["stop".into(), self.unit.clone()])?;
                systemctl(&["revert".into(), self.unit.clone()])?;
            }
            Ok(())
        };
        if let Err(e) = cleanup() {
            tracing::warn!("cell process tree cleanup: {e}");
        }
    }
}
pub(super) struct Resources {
    limits: Limits,
    tree_limits: Limits,
    tree: Option<Tree>,
}
impl Resources {
    pub fn new(session: &Session, cfg: &Config) -> Result<Self> {
        let limits = cfg.process_limits.clone().unwrap_or_default();
        let tree_limits = cfg.tree_process_limits.clone().unwrap_or_default();
        if limits.active() || tree_limits.active() {
            ensure!(
                Path::new("/usr/bin/systemd-run").is_file()
                    && Path::new("/sys/fs/cgroup/cgroup.controllers").exists(),
                "process budgets require systemd and cgroup v2"
            );
        }
        let tree = tree_limits
            .active()
            .then(|| Tree::open(session, &tree_limits))
            .transpose()?;
        Ok(Self {
            limits,
            tree_limits,
            tree,
        })
    }
    pub fn wrap(&self, cmd: Command) -> Result<Command> {
        if !self.limits.active() && self.tree.is_none() {
            return Ok(cmd);
        }
        let inner = cmd.as_std();
        let mut scope = Command::new("/usr/bin/systemd-run");
        scope.env_clear();
        for (k, v) in inner.get_envs() {
            if let Some(v) = v {
                scope.env(k, v);
            }
        }
        user_bus(scope.as_std_mut());
        if let Some(cwd) = inner.get_current_dir() {
            scope.current_dir(cwd);
        }
        let unit = format!("wasmedge-agent-{}.scope", uuid::Uuid::new_v4());
        scope
            .args([
                "--user",
                "--scope",
                "--expand-environment=no",
                "--quiet",
                "--collect",
            ])
            .arg(format!("--unit={unit}"));
        let (mut properties, mut checks) = controls(&self.limits, true);
        if let Some(tree) = &self.tree {
            scope.arg(format!("--slice={}", tree.unit));
            checks.extend(
                controls(&self.tree_limits, false)
                    .1
                    .into_iter()
                    .map(|(k, v)| (format!("../{k}"), v)),
            );
            if self.tree_limits.memory_max_mb.is_some() && self.limits.memory_max_mb.is_none() {
                properties.push("OOMPolicy=kill".into());
                checks.push(("memory.oom.group".into(), "1".into()));
            }
        }
        for p in properties {
            scope.arg(format!("--property={p}"));
        }
        scope.args([
            "--",
            "/bin/sh",
            "-eu",
            "-c",
            include_str!("verify-cgroup.sh"),
            "process-limits",
            &unit,
            self.tree.as_ref().map_or("-", |t| t.unit.as_str()),
        ]);
        for (k, v) in checks {
            scope.arg(k).arg(v);
        }
        scope
            .arg("--")
            .arg(inner.get_program())
            .args(inner.get_args());
        Ok(scope)
    }
}
pub(super) fn target(ws: &Path, cfg: &Config) -> PathBuf {
    let target = ws.join("target");
    if cfg.bwrap() {
        target.join("cargo-sandbox")
    } else {
        target
    }
}
fn safe_dir(p: &Path) -> Result<()> {
    if let Ok(m) = p.symlink_metadata() {
        ensure!(
            m.is_dir() && !m.is_symlink(),
            "expected a real directory: {}",
            p.display()
        );
    }
    fs::create_dir_all(p)?;
    Ok(())
}
pub(super) fn cargo(
    ws: &Path,
    cfg: &Config,
    resources: &Resources,
    args: &[&str],
    network_vendor: Option<&Path>,
) -> Result<Command> {
    let ws = ws.canonicalize()?;
    let cargo = config::program("cargo", "WASMEDGE_AGENT_CARGO");
    let target = target(&ws, cfg);
    let mut cmd;
    if !cfg.bwrap() {
        cmd = process::command(&cargo, &ws);
        cmd.args(args);
    } else {
        ensure!(
            Path::new("/usr/bin/bwrap").exists() && cargo.is_absolute(),
            "Bubblewrap requires /usr/bin/bwrap and an absolute Cargo path"
        );
        let home = pa_types::platform::home_dir()
            .context("missing home")?
            .canonicalize()?;
        ensure!(
            !home.starts_with(&ws)
                && !["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/tmp", "/var"]
                    .contains(&ws.to_str().unwrap_or("")),
            "requires a dedicated Cargo workspace"
        );
        let cargo_home =
            std::env::var_os("CARGO_HOME").map_or_else(|| home.join(".cargo"), PathBuf::from);
        let rustup =
            std::env::var_os("RUSTUP_HOME").map_or_else(|| home.join(".rustup"), PathBuf::from);
        cmd = process::command("/usr/bin/bwrap", &ws);
        cmd.args([
            "--unshare-all",
            "--unshare-user",
            "--disable-userns",
            "--die-with-parent",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--dir",
            "/tmp/home",
            "--dir",
            "/tmp/cargo-home",
        ]);
        let system = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
        for p in system
            .into_iter()
            .chain(["/etc/ld.so.cache", "/etc/alternatives"])
        {
            if Path::new(p).exists() {
                cmd.args(["--ro-bind", p, p]);
            }
        }
        let readonly = |cmd: &mut Command, p: &Path| -> Result<()> {
            let physical = p.canonicalize()?;
            ensure!(
                physical.parent().is_some()
                    && !home.starts_with(&physical)
                    && !ws.starts_with(&physical),
                "refusing broad sandbox mount {}",
                p.display()
            );
            cmd.arg("--ro-bind").arg(physical).arg(p);
            Ok(())
        };
        for binary in
            std::iter::once(cargo.clone()).chain(std::env::var_os("RUSTC").map(PathBuf::from))
        {
            ensure!(binary.is_absolute(), "sandbox requires absolute binaries");
            if !system.iter().any(|p| binary.starts_with(p)) {
                readonly(
                    &mut cmd,
                    binary.parent().context("invalid binary directory")?,
                )?;
            }
        }
        if rustup.exists() {
            readonly(&mut cmd, &rustup)?;
        }
        let reg = cargo_home.join("registry");
        if reg.exists() {
            let p = reg.canonicalize()?;
            ensure!(
                p.parent().is_some() && !home.starts_with(&p) && !ws.starts_with(&p),
                "unsafe registry mount"
            );
            cmd.arg(if network_vendor.is_some() {
                "--bind"
            } else {
                "--ro-bind"
            })
            .arg(p)
            .arg("/tmp/cargo-home/registry");
        }
        if network_vendor.is_some() {
            cmd.arg("--share-net");
            for p in ["/etc/resolv.conf", "/etc/hosts", "/etc/ssl/certs"] {
                if Path::new(p).exists() {
                    cmd.args(["--ro-bind", p, p]);
                }
            }
        }
        if ws.join("skills").exists() {
            for e in fs::read_dir(ws.join("skills"))? {
                let e = e?;
                if e.file_type()?.is_symlink() {
                    let p = e.path().canonicalize()?;
                    readonly(&mut cmd, &p)?;
                }
            }
        }
        safe_dir(&ws.join("target"))?;
        safe_dir(&target)?;
        let lock = ws.join("Cargo.lock");
        if !lock.exists() {
            fs::File::create_new(&lock)?;
        }
        let meta = lock.symlink_metadata()?;
        ensure!(meta.is_file() && !meta.is_symlink(), "unsafe Cargo.lock");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            ensure!(meta.nlink() == 1, "hardlinked Cargo.lock");
        }
        cmd.arg("--ro-bind")
            .arg(&ws)
            .arg(&ws)
            .arg("--tmpfs")
            .arg(ws.join("target"))
            .arg("--bind")
            .arg(&target)
            .arg(&target)
            .arg("--bind")
            .arg(&lock)
            .arg(&lock);
        if let Some(v) = network_vendor {
            ensure!(
                v.parent() == Some(ws.as_path())
                    && v.file_name()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| s == "vendor" || s.starts_with("vendor.tmp-")),
                "invalid vendor staging directory"
            );
            safe_dir(v)?;
            cmd.arg("--bind").arg(v).arg(v);
        }
        for n in [".git", "state", ".scratch"] {
            let p = ws.join(n);
            if p.symlink_metadata().is_ok() {
                safe_dir(&p)?;
                cmd.arg("--tmpfs").arg(p);
            }
        }
        for n in ["config", "config.toml", "credentials", "credentials.toml"] {
            let p = cargo_home.join(n);
            if p.exists() {
                cmd.args(["--ro-bind", "/dev/null"]).arg(p);
            }
        }
        cmd.arg("--chdir").arg(&ws).arg("--").arg(&cargo).args(args);
        let path = std::env::join_paths([
            cargo
                .parent()
                .ok_or_else(|| anyhow!("invalid cargo path"))?,
            Path::new("/usr/local/bin"),
            Path::new("/usr/bin"),
            Path::new("/bin"),
        ])?;
        cmd.env("HOME", "/tmp/home")
            .env("CARGO_HOME", "/tmp/cargo-home")
            .env("RUSTUP_HOME", rustup)
            .env("RUSTUP_AUTO_INSTALL", "0")
            .env("PATH", path);
        for var in ["TMP", "TEMP", "TMPDIR"] {
            cmd.env(var, "/tmp");
        }
    }
    for var in [
        "CARGO_TARGET_DIR",
        "CARGO_BUILD_TARGET_DIR",
        "CARGO_BUILD_BUILD_DIR",
    ] {
        cmd.env(var, &target);
    }
    if network_vendor.is_none() {
        cmd.env("CARGO_NET_OFFLINE", "true");
    }
    resources.wrap(cmd)
}

pub(super) async fn build(command: Command) -> Result<process::Output> {
    static GATE: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let semaphore = GATE.get_or_init(|| {
        let default = (std::thread::available_parallelism().map_or(4, usize::from) / 2).clamp(2, 8);
        let permits = std::env::var("WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(default)
            .min(32);
        tokio::sync::Semaphore::new(permits)
    });
    let _permit = semaphore.acquire().await?;
    process::run(command, None).await
}
