use super::super::tool_definition::{OnUpdate, ToolContentBlock, ToolUpdate};
use crate::platform::process::{set_new_process_group, signal_process_group, Signal};
use anyhow::{Context, Result};
use std::{
    path::Path,
    process::{ExitStatus, Stdio},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
};

pub(super) const OUTPUT_LIMIT: usize = 131_072;
pub(super) fn command(exe: impl AsRef<std::ffi::OsStr>, cwd: &Path) -> Command {
    let mut command = Command::new(exe);
    command.current_dir(cwd).env_clear().kill_on_drop(true);
    for (key, value) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if matches!(
            name.as_str(),
            "PATH"
                | "HOME"
                | "USERPROFILE"
                | "SYSTEMROOT"
                | "WINDIR"
                | "COMSPEC"
                | "PATHEXT"
                | "TEMP"
                | "TMP"
                | "TMPDIR"
                | "SDKROOT"
                | "MACOSX_DEPLOYMENT_TARGET"
                | "CARGO_HOME"
                | "CARGO_NET_OFFLINE"
                | "RUSTUP_HOME"
                | "RUSTUP_TOOLCHAIN"
                | "RUSTUP_AUTO_INSTALL"
                | "RUSTC"
        ) {
            command.env(key, value);
        }
    }
    command
}
pub(super) struct ChildGroup {
    pub child: Child,
    pid: Option<i32>,
}
impl ChildGroup {
    pub fn spawn(cmd: &mut Command) -> Result<Self> {
        set_new_process_group(cmd.as_std_mut());
        cmd.kill_on_drop(true);
        let child = cmd.spawn().with_context(|| {
            format!("starting {}", cmd.as_std().get_program().to_string_lossy())
        })?;
        let pid = child.id().and_then(|id| i32::try_from(id).ok());
        Ok(Self { child, pid })
    }
}
impl Drop for ChildGroup {
    fn drop(&mut self) {
        if let Some(pid) = self.pid.take() {
            let _ = signal_process_group(pid, Signal::Kill);
        }
        let _ = self.child.start_kill();
    }
}
pub(super) async fn read_output(
    mut stream: impl AsyncRead + Unpin,
    updates: Option<&OnUpdate>,
) -> Result<(String, bool)> {
    let mut output = Vec::new();
    let mut buf = [0; 8192];
    let mut overflow = false;
    loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let keep = n.min(OUTPUT_LIMIT.saturating_sub(output.len()));
        output.extend_from_slice(&buf[..keep]);
        overflow |= n > keep;
        if let Some(notify) = updates {
            notify(ToolUpdate {
                content: vec![ToolContentBlock::text(String::from_utf8_lossy(&buf[..n]))],
                details: None,
            });
        }
    }
    Ok((String::from_utf8_lossy(&output).into_owned(), overflow))
}
pub(super) struct Output {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}
impl Output {
    pub fn require(self, operation: &str) -> Result<Self> {
        anyhow::ensure!(
            self.status.success(),
            "{operation} failed ({}): {}{}",
            self.status,
            self.stderr,
            self.stdout
        );
        Ok(self)
    }
}
pub(super) async fn run(mut cmd: Command, updates: Option<&OnUpdate>) -> Result<Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut group = ChildGroup::spawn(&mut cmd)?;
    let stdout = group.child.stdout.take().context("missing child stdout")?;
    let stderr = group.child.stderr.take().context("missing child stderr")?;
    let (status, (stdout, a), (stderr, b)) = tokio::try_join!(
        async { Ok::<_, anyhow::Error>(group.child.wait().await?) },
        read_output(stdout, updates),
        read_output(stderr, updates)
    )?;
    Ok(Output {
        status,
        stdout,
        stderr,
        truncated: a || b,
    })
}
