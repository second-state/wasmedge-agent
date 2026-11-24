use super::{config, guest::Guest, process, sandbox, wasm, workspace, Session};
use anyhow::{ensure, Context, Result};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

pub(super) fn identifier(s: &str) -> bool {
    s.as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
pub(super) fn replace(path: &Path, content: &str) -> Result<()> {
    if fs::read(path).ok().as_deref() != Some(content.as_bytes()) {
        workspace::atomic(path, content.as_bytes())?;
    }
    Ok(())
}
const BEGIN: &str = "# --- skills (managed by wasmedge-agent; do not edit) ---";
const END: &str = "# --- end skills ---";

pub(super) fn sync(session: &Session, ws: &Path) -> Result<()> {
    let mounts = ws.join("skills");
    fs::create_dir_all(&mounts)?;
    let mut wanted = BTreeMap::new();
    for skill in &session.skills {
        let root = skill.parent().context("invalid skill directory")?;
        if !root.join("Cargo.toml").is_file() || !root.join("src/lib.rs").is_file() {
            continue;
        }
        let manifest = fs::read_to_string(root.join("Cargo.toml"))?;
        let Ok(manifest) = toml::from_str::<toml::Value>(&manifest) else {
            tracing::warn!(skill = %root.display(), "ignoring malformed skill manifest");
            continue;
        };
        let Some(name) = manifest
            .get("package")
            .and_then(|p| p.get("name"))
            .and_then(toml::Value::as_str)
            .filter(|n| identifier(n))
        else {
            continue;
        };
        if ["agent_lib", "cell", "rlm"].contains(&name) {
            continue;
        }
        wanted
            .entry(name.to_owned())
            .or_insert(root.canonicalize()?);
    }
    for entry in fs::read_dir(&mounts)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("invalid skill name"))?;
        if entry.file_type()?.is_symlink() {
            if wanted.get(&name) != fs::read_link(entry.path()).ok().as_ref() {
                #[cfg(not(windows))]
                fs::remove_file(entry.path())?;
                #[cfg(windows)]
                fs::remove_dir(entry.path())?;
            }
        } else if ws.join(".inherited-workspace").is_file()
            && identifier(&name)
            && entry.path().join("Cargo.toml").is_file()
        {
            wanted.insert(name, entry.path());
        }
    }
    for (name, source) in &wanted {
        let mount = mounts.join(name);
        if mount.try_exists()? {
            ensure!(
                mount.canonicalize()? == source.canonicalize()?,
                "conflicting skill mount {name}"
            );
            continue;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(source, mount)?;
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(source, mount)?;
    }
    let members: Vec<_> = ["agent_lib", "cell", "rlm"]
        .into_iter()
        .map(str::to_owned)
        .chain(wanted.keys().map(|s| format!("skills/{s}")))
        .collect();
    let root = ws.join("Cargo.toml");
    let manifest = fs::read_to_string(&root)?;
    let members_line = manifest
        .lines()
        .find(|line| line.trim_start().starts_with("members = ["))
        .context("missing guest workspace members")?;
    replace(
        &root,
        &manifest.replacen(
            members_line,
            &format!("members = {}", serde_json::to_string(&members)?),
            1,
        ),
    )?;
    let path = ws.join("agent_lib/Cargo.toml");
    let mut manifest = fs::read_to_string(&path)?;
    if let Some(start) = manifest.find(BEGIN) {
        let end = manifest[start..]
            .find(END)
            .context("invalid managed skills block")?
            + start
            + END.len();
        manifest.replace_range(start..end, "");
    }
    let mut body = manifest.trim_end().to_owned();
    let mut index = String::from("//! Mounted Rust skills.\n");
    if !wanted.is_empty() {
        body.push_str(&format!("\n\n{BEGIN}\n"));
        for name in wanted.keys() {
            body.push_str(&format!("{name} = {{ path = \"../skills/{name}\" }}\n"));
            index.push_str(&format!("pub use {name};\n"));
        }
        body.push_str(END);
    }
    body.push('\n');
    replace(&path, &body)?;
    replace(&ws.join("agent_lib/src/skills/mod.rs"), &index)
}

pub(super) async fn test_reference(guest: &Guest<'_>, reference: &Value) -> Result<()> {
    let path = reference["use"]
        .as_str()
        .and_then(|s| s.strip_prefix("agent_lib::skills::"))
        .context("expected an agent_lib::skills::<crate> reference")?;
    ensure!(
        reference["type"] == "rust" && path.split("::").all(identifier),
        "invalid Rust skill reference"
    );
    let name = path.split("::").next().unwrap_or_default();
    ensure!(
        guest
            .ws
            .join("skills")
            .join(name)
            .join("Cargo.toml")
            .is_file(),
        "skill crate {name} is not mounted"
    );
    test(guest, name, &[]).await
}
pub(super) async fn test(guest: &Guest<'_>, name: &str, edits: &[Value]) -> Result<()> {
    let before = workspace::fingerprint(guest.ws)?;
    let root = tempfile::tempdir()?;
    let ws = root.path().join("workspace");
    workspace::snapshot(guest.ws, &ws)?;
    ensure!(
        workspace::fingerprint(&ws)? == before,
        "skill sources changed during snapshot"
    );
    let mut transaction = workspace::Changes::new();
    workspace::lib_edits(&ws, edits, &mut transaction)?;
    transaction.commit();
    // Resolve newly mounted path crates before pinning the snapshot used for test discovery.
    sandbox::build(sandbox::cargo(
        &ws,
        guest.config,
        guest.resources,
        &["metadata", "--offline", "--format-version=1"],
        None,
    )?)
    .await?
    .require("resolve WASI test dependencies")?;
    let staged = workspace::fingerprint(&ws)?;
    let args = [
        "test",
        "--locked",
        "--release",
        "--offline",
        "--target",
        "wasm32-wasip1",
        "--no-run",
        "--lib",
        "--tests",
        "-p",
        name,
        "--message-format=json-diagnostic-rendered-ansi",
    ];
    let cmd = sandbox::cargo(&ws, guest.config, guest.resources, &args, None)?;
    let build = sandbox::build(cmd).await?.require("WASI test build")?;
    ensure!(
        !build.truncated,
        "truncated Cargo output while enumerating test modules"
    );
    let target = sandbox::target(&ws, guest.config).canonicalize()?;
    let mut files = BTreeSet::new();
    for line in build.stdout.lines().filter(|l| l.starts_with('{')) {
        let msg: Value = serde_json::from_str(line)?;
        if msg["reason"] == "compiler-artifact" && msg["profile"]["test"] == true {
            let Some(file) = msg["executable"].as_str() else {
                continue;
            };
            let file = PathBuf::from(file).canonicalize()?;
            ensure!(
                file.starts_with(&target) && file.extension().is_some_and(|e| e == "wasm"),
                "unexpected WASI test artifact"
            );
            files.insert(file);
        }
    }
    ensure!(!files.is_empty(), "no WASI tests built");
    let mut modules = Vec::new();
    for file in files {
        let dir = tempfile::tempdir_in(root.path())?;
        let module = wasm::prepare(&file, dir.path(), guest.config, guest.resources, false).await?;
        modules.push((dir, module));
    }
    let scratch = root.path().join("scratch");
    fs::create_dir(&scratch)?;
    let mut count = 0usize;
    for (_, module) in &modules {
        let mut cmd = process::command(config::program("wasmedge", "WASMEDGE_AGENT_WASMEDGE"), &ws);
        cmd.args(guest.config.wasm_args())
            .args(["--force-interpreter", "--dir"])
            .arg(format!("/scratch:{}", scratch.display()))
            .arg(module)
            .args(["--test-threads=1", "--nocapture"]);
        let result = process::run(guest.resources.wrap(cmd)?, None)
            .await?
            .require("sandboxed tests")?;
        let passed = result
            .stdout
            .lines()
            .find_map(|line| {
                line.strip_prefix("test result: ok. ")?
                    .split_once(" passed; 0 failed;")?
                    .0
                    .parse::<usize>()
                    .ok()
            })
            .context("expected standard Rust test harness result")?;
        count += passed;
    }
    ensure!(
        count > 0,
        "registration requires at least one passing, non-ignored test"
    );
    ensure!(
        workspace::fingerprint(guest.ws)? == before && workspace::fingerprint(&ws)? == staged,
        "skill sources changed during testing"
    );
    Ok(())
}
