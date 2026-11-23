//! Upgrade the managed scaffold in a sibling directory while the workspace lease is held.
use super::{config, guest::Guest, host, maintenance, sandbox, skills, workspace};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Component, Path},
};

const HOST_FILES: &[&str] = &[
    ".cargo/config.toml",
    "Cargo.toml",
    "Cargo.lock",
    "agent_lib/Cargo.toml",
    "cell/Cargo.toml",
    "rlm",
];
const MARKER: &str = ".workspace-version";

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn record(root: &Path, path: &Path, hashes: &mut Map<String, Value>) -> Result<()> {
    let full = root.join(path);
    let meta = fs::symlink_metadata(&full)?;
    if meta.is_dir() {
        for name in workspace::names(&full)? {
            if name != "target" && name != "vendor" && name != ".git" {
                record(root, &path.join(name), hashes)?;
            }
        }
    } else {
        ensure!(meta.is_file(), "invalid template asset {}", full.display());
        hashes.insert(
            path.to_string_lossy().replace('\\', "/"),
            json!(digest(&fs::read(full)?)),
        );
    }
    Ok(())
}

async fn stamp(guest: &Guest<'_>, root: &Path) -> Result<Value> {
    let mut files = Map::new();
    for name in HOST_FILES
        .iter()
        .copied()
        .chain(["agent_lib/src", "cell/src"])
    {
        record(root, Path::new(name), &mut files)?;
    }
    // Keep the field insertion order used by the previously shipped workspace marker.
    let dependencies: Map<_, _> = files
        .iter()
        .filter(|(k, _)| k.ends_with("Cargo.toml") || k.ends_with("Cargo.lock"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let sources: Map<_, _> = files
        .iter()
        .filter(|(k, _)| k.starts_with("agent_lib/src/"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let (rustc, engine) = guest
        .runtime
        .versions
        .get_or_try_init(|| async {
            Ok::<_, anyhow::Error>((
                maintenance::invoke(&config::program("rustc", "RUSTC"), root, &["--version"])
                    .await?,
                maintenance::invoke(
                    &config::program("wasmedge", "WASMEDGE_AGENT_WASMEDGE"),
                    root,
                    &["--version"],
                )
                .await?,
            ))
        })
        .await?;
    Ok(
        json!({"schema":1,"templateHash":digest(&serde_json::to_vec(&files)?),"dependencyHash":digest(&serde_json::to_vec(&dependencies)?),
        "sourceHashes":sources,"rustcVersion":rustc,"wasmedgeVersion":engine}),
    )
}

fn previous(ws: &Path) -> Result<Value> {
    let path = ws.join(MARKER);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Value::Null),
        Ok(meta) => ensure!(
            meta.is_file() && meta.len() < 1024 * 1024,
            "invalid workspace version"
        ),
        Err(e) => return Err(e.into()),
    }
    let prior: Value = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        prior["schema"] == 1
            && prior["sourceHashes"].is_object()
            && prior["templateHash"].is_string(),
        "invalid workspace version"
    );
    Ok(prior)
}

fn clone_existing(src: &Path, dst: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.is_dir() {
        fs::create_dir(dst)?;
        for name in workspace::names(src)? {
            clone_existing(&src.join(&name), &dst.join(name))?;
        }
    } else if meta.is_symlink() {
        let link = fs::read_link(src)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(link, dst)?;
        #[cfg(windows)]
        if meta.file_type().is_symlink() && src.is_dir() {
            std::os::windows::fs::symlink_dir(link, dst)?;
        } else {
            std::os::windows::fs::symlink_file(link, dst)?;
        }
    } else {
        ensure!(
            meta.is_file(),
            "unsupported workspace entry {}",
            src.display()
        );
        fs::copy(src, dst)?;
    }
    Ok(())
}

fn remove(path: &Path) -> Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if meta.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn refresh(template: &Path, next: &Path, before: &Value, after: &Value) -> Result<()> {
    for name in [
        ".cargo",
        "agent_lib",
        "agent_lib/src",
        "agent_lib/src/skills",
        "agent_lib/src/helpers",
        "cell",
        "cell/src",
        "skills",
    ] {
        if let Ok(meta) = next.join(name).symlink_metadata() {
            ensure!(meta.is_dir(), "linked or invalid scaffold directory {name}");
        }
    }
    for name in HOST_FILES.iter().copied().chain(["vendor"]) {
        let path = next.join(name);
        remove(&path)?;
        workspace::copy_entry(&template.join(name), &path)?;
    }
    let sources = &after["sourceHashes"];
    let mut names = std::collections::BTreeSet::new();
    for source in [&before["sourceHashes"], sources] {
        if let Some(m) = source.as_object() {
            names.extend(m.keys());
        }
    }
    for name in names {
        let rel = Path::new(name);
        ensure!(
            rel.starts_with("agent_lib/src")
                && rel.components().all(|p| matches!(p, Component::Normal(_))),
            "invalid source path in workspace version"
        );
        if rel.starts_with("agent_lib/src/helpers") || rel.starts_with("agent_lib/src/skills") {
            continue;
        }
        let path = next.join(rel);
        // A user-owned symlink, deletion, or modified source stays as it is.
        if rel.ancestors().skip(1).any(|p| next.join(p).is_symlink()) {
            continue;
        }
        match fs::symlink_metadata(&path) {
            Ok(meta)
                if !meta.is_file()
                    || before["sourceHashes"][name].as_str()
                        != Some(&digest(&fs::read(&path)?)) =>
            {
                continue
            }
            Err(e)
                if e.kind() == io::ErrorKind::NotFound
                    && before["sourceHashes"].get(name).is_some() =>
            {
                continue
            }
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
            _ => (),
        }
        remove(&path)?;
        if sources.get(name).is_some() {
            workspace::copy_entry(&template.join(rel), &path)?;
        }
    }
    remove(&next.join(".native-prelude.json"))?;
    Ok(())
}

pub(super) fn recover(ws: &Path) -> Result<()> {
    let dir = ws.with_file_name(".workspace.upgrade");
    if !dir.try_exists()? {
        return Ok(());
    }
    ensure!(
        dir.symlink_metadata()?.is_dir(),
        "invalid upgrade transaction"
    );
    let owner: Value = serde_json::from_slice(&fs::read(dir.join("owner.json"))?)?;
    let pid = owner["pid"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .context("invalid upgrade owner")?;
    ensure!(
        pid == 0 || !pa_types::platform::process::is_process_alive(pid)?,
        "workspace upgrade already running"
    );
    let backup = dir.join("previous");
    if backup.try_exists()? && !ws.try_exists()? {
        fs::rename(&backup, ws)?;
    }
    fs::remove_dir_all(dir)?;
    Ok(())
}

pub(super) async fn prepare(guest: &Guest<'_>, template: &Path) -> Result<()> {
    let ws = guest.ws;
    let parent = ws.parent().context("missing workspace parent")?;
    let existing = ws.join("Cargo.toml").is_file();
    if let Ok(meta) = ws.symlink_metadata() {
        ensure!(
            meta.is_dir() && (existing || fs::read_dir(ws)?.next().is_none()),
            "invalid existing workspace {}",
            ws.display()
        );
    }
    let seed = guest.runtime.session.session_dir.join(workspace::SEED);
    let inherited = !existing && seed.join("Cargo.toml").is_file();
    let before = previous(if inherited { &seed } else { ws })?;
    let after = stamp(guest, template).await?;
    let matches = ["templateHash", "rustcVersion", "wasmedgeVersion"]
        .iter()
        .all(|k| before[k] == after[k]);
    if existing && matches {
        return Ok(());
    }
    let stage = tempfile::Builder::new()
        .prefix(".prepare-workspace-")
        .tempdir_in(parent)?;
    let next = stage.path().join("next");
    if inherited {
        workspace::snapshot(&seed, &next)?;
    } else {
        fs::create_dir(&next)?;
        if existing {
            for name in workspace::names(ws)? {
                if name != "target" && name != "vendor" && name != ".scratch" {
                    clone_existing(&ws.join(&name), &next.join(name))?;
                }
            }
        } else {
            for name in [
                ".cargo",
                "Cargo.toml",
                "Cargo.lock",
                "agent_lib",
                "cell",
                "rlm",
                "vendor",
                "target",
            ] {
                let input = template.join(name);
                if input.try_exists()? {
                    workspace::copy_entry(&input, &next.join(name))?;
                }
            }
        }
    }
    if (existing || inherited) && !matches {
        refresh(template, &next, &before, &after)?;
        let staged = Guest {
            ws: &next,
            ..*guest
        };
        let retained = fs::read(next.join("cell/src/main.rs"))?;
        workspace::atomic(&next.join("cell/src/main.rs"), b"fn main() {}\n")?;
        skills::sync(&guest.runtime.session, &next)?;
        host::configure(&staged).await?;
        sandbox::build(sandbox::cargo(
            &next,
            guest.config,
            guest.resources,
            &["build", "--release", "--offline", "-p", "cell"],
            None,
        )?)
        .await?
        .require("workspace upgrade validation")?;
        workspace::atomic(&next.join("cell/src/main.rs"), &retained)?;
    }
    workspace::atomic(&next.join(MARKER), &serde_json::to_vec_pretty(&after)?)?;
    if !existing && guest.runtime.session.persistent {
        workspace::history(&next, "Initial Rust workspace").await?;
    }
    // No await during publication. An interrupted two-rename is recovered under
    // the same lease on the next open, including legacy upgrade journals.
    let journal = ws.with_file_name(".workspace.upgrade");
    workspace::atomic(&stage.path().join("owner.json"), br#"{"pid":0}"#)?;
    fs::rename(stage.path(), &journal)?;
    if ws.exists() {
        fs::rename(ws, journal.join("previous"))?;
    }
    if let Err(e) = fs::rename(journal.join("next"), ws) {
        recover(ws)?;
        return Err(e.into());
    }
    fs::remove_dir_all(journal)?;
    Ok(())
}
