use super::{process::ChildGroup, OnUpdate, Session, ToolExecutionResult};
use crate::tools::tool_definition::{ToolContentBlock, ToolUpdate};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{collections::VecDeque, io::Write, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

// Only pass a literal directory to git. Shell expansion in a relocation cannot
// be evaluated safely during a status probe.
async fn guard_git(session: &Session, command: &str) -> Result<()> {
    let mut cwd = session.cwd.clone();
    let mut unresolved = false;
    for segment in command.split([';', '|', '&', '\n', '(', ')']) {
        let Some(words) = shlex::split(segment) else {
            continue;
        };
        let mut iter = words.iter().map(String::as_str).peekable();
        while let Some(word) = iter.next() {
            if word == "cd" || word == "pushd" || word == "popd" {
                if let Some(dir) = iter
                    .next()
                    .filter(|s| !s.contains(['$', '~', '\x60', '*']) && !s.starts_with('-'))
                {
                    cwd = cwd.join(dir);
                } else {
                    unresolved = true;
                }
                break;
            }
            if word.contains('=') {
                unresolved |= word.starts_with("GIT_");
                continue;
            }
            if matches!(word, "command" | "env" | "sudo" | "exec" | "then" | "do") {
                continue;
            }
            if word.rsplit('/').next() != Some("git") {
                break;
            }
            let mut dir = cwd.clone();
            while iter.peek().is_some_and(|s| s.starts_with('-')) {
                match iter.next() {
                    Some("-C") => {
                        if let Some(d) =
                            iter.next().filter(|s| !s.contains(['$', '~', '\x60', '*']))
                        {
                            dir = dir.join(d);
                        } else {
                            unresolved = true;
                        }
                    }
                    Some("-c" | "--git-dir" | "--work-tree") => {
                        iter.next();
                        unresolved = true;
                    }
                    Some(arg)
                        if arg.starts_with("--git-dir=") || arg.starts_with("--work-tree=") =>
                    {
                        unresolved = true
                    }
                    _ => {}
                }
            }
            let sub = iter.next().unwrap_or("");
            let args = iter.collect::<Vec<_>>();
            let opts = args
                .iter()
                .take_while(|a| **a != "--")
                .copied()
                .collect::<Vec<_>>();
            let clean_flag = |c| {
                opts.iter()
                    .any(|s| s.starts_with('-') && !s.starts_with("--") && s.contains(c))
            };
            let destructive = match sub {
                "clean" => {
                    (clean_flag('f') || opts.contains(&"--force"))
                        && !clean_flag('n')
                        && !opts.contains(&"--dry-run")
                }
                "reset" => opts.contains(&"--hard"),
                "checkout" | "restore" => args
                    .iter()
                    .any(|s| matches!(*s, "." | "./" | ":/" | "-f" | "--force")),
                _ => false,
            };
            if destructive {
                ensure!(!unresolved,"cannot safely resolve target of destructive git command; use allowDestructiveGit to confirm");
                let mut git = Command::new("git");
                git.current_dir(&dir)
                    .args(["status", "--porcelain", "--untracked-files=all"]);
                if sub == "clean" && (clean_flag('x') || clean_flag('X')) {
                    git.arg("--ignored");
                }
                let output = super::process::run(git, None).await?;
                ensure!(!output.status.success()||output.stdout.is_empty(),"refusing destructive git command with uncommitted changes in {}; use allowDestructiveGit to confirm",dir.display());
            }
            break;
        }
    }
    Ok(())
}
pub(super) async fn execute(
    session: &Session,
    args: &Value,
    updates: Option<&OnUpdate>,
) -> Result<ToolExecutionResult> {
    let command = args["command"]
        .as_str()
        .context("bash requires a command")?;
    let settings = crate::settings::SettingsManager::create(&session.cwd, &session.agent_dir);
    let shell =
        crate::platform::shell::get_shell_config(settings.settings().shell_path.as_deref())?;
    let full = settings
        .settings()
        .shell_command_prefix
        .as_ref()
        .map_or_else(
            || command.to_owned(),
            |prefix| format!("{prefix}\n{command}"),
        );
    if args["allowDestructiveGit"] != true
        && !std::env::var("PI_BASH_ALLOW_DESTRUCTIVE_GIT")
            .is_ok_and(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
    {
        guard_git(session, &full).await?;
    }
    let mut cmd = Command::new(shell.shell);
    cmd.args(shell.args)
        .arg(full)
        .current_dir(&session.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = ChildGroup::spawn(&mut cmd)?;
    let mut stdout = child.child.stdout.take().context("missing shell stdout")?;
    let mut stderr = child.child.stderr.take().context("missing shell stderr")?;
    let collect = async {
        let mut out = [0; 8192];
        let mut err = [0; 8192];
        let (mut ended_out, mut ended_err) = (false, false);
        let mut tail = VecDeque::new();
        let mut spool = None;
        let mut bytes = 0usize;
        while !ended_out || !ended_err {
            let chunk = tokio::select! {
                n=stdout.read(&mut out), if !ended_out=>{let n=n?; ended_out=n==0; &out[..n]},
                n=stderr.read(&mut err), if !ended_err=>{let n=n?; ended_err=n==0; &err[..n]},
            };
            if chunk.is_empty() {
                continue;
            }
            if let Some(notify) = updates {
                notify(ToolUpdate {
                    content: vec![ToolContentBlock::text(String::from_utf8_lossy(chunk))],
                    details: None,
                });
            }
            bytes += chunk.len();
            if spool.is_none()
                && (bytes > 50 * 1024
                    || tail.iter().chain(chunk).filter(|c| **c == b'\n').count() > 2000)
            {
                let mut f = tempfile::Builder::new()
                    .prefix("wasmedge-bash-")
                    .suffix(".log")
                    .tempfile()?;
                f.write_all(tail.make_contiguous())?;
                spool = Some(f);
            }
            if let Some(f) = &mut spool {
                f.write_all(chunk)?;
            }
            tail.extend(chunk);
            tail.drain(..tail.len().saturating_sub(50 * 1024));
        }
        let status = child.child.wait().await?;
        let raw = String::from_utf8_lossy(tail.make_contiguous());
        let lines: Vec<_> = raw.lines().rev().take(2000).collect();
        let mut output = lines.into_iter().rev().collect::<Vec<_>>().join("\n");
        let mut details = None;
        if let Some(file) = spool {
            let (_, path) = file.keep()?;
            output.push_str(&format!(
                "\n[Output truncated. Full output: {}]",
                path.display()
            ));
            details = Some(json!({"fullOutputPath":path,"truncated":true}));
        }
        if !status.success() {
            output.push_str(&format!(
                "\nCommand exited with code {}",
                status.code().unwrap_or(-1)
            ));
        }
        Ok(ToolExecutionResult {
            content: vec![ToolContentBlock::text(if output.is_empty() {
                "(no output)".to_owned()
            } else {
                output
            })],
            details,
            is_error: !status.success(),
            terminate: None,
        })
    };
    if let Some(n) = args.get("timeout") {
        let Some(seconds) = n.as_f64().and_then(|n| Duration::try_from_secs_f64(n).ok()) else {
            bail!("invalid bash timeout")
        };
        return tokio::time::timeout(seconds, collect)
            .await
            .context("bash command timed out")?;
    }
    collect.await
}
