use super::{config, process, workspace};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) async fn invoke(program: &Path, dir: &Path, args: &[&str]) -> Result<String> {
    let mut cmd = process::command(program, dir);
    cmd.args(args);
    Ok(process::run(cmd, None)
        .await?
        .require(program.to_str().unwrap_or("tool"))?
        .stdout
        .trim()
        .into())
}
pub(super) async fn prepare_template(root: &Path, warm_build: bool) -> Result<Vec<String>> {
    let cargo = config::program("cargo", "WASMEDGE_AGENT_CARGO");
    let warm = root.join("target/wasm32-wasip1/release/cell.wasm");
    let vendor = root.join("vendor");
    let mut repairs = Vec::new();
    if (warm_build && !warm.is_file()) || !vendor.is_dir() {
        let lock = root
            .parent()
            .context("missing template parent")?
            .join(".template-preparation.lock");
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock)?;
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(fs::TryLockError::WouldBlock) => {
                    tokio::time::sleep(Duration::from_millis(50)).await
                }
                Err(fs::TryLockError::Error(e)) => return Err(e.into()),
            }
        }
        if !vendor.is_dir() {
            let t = tempfile::tempdir_in(root)?;
            let dest = t.path().join("vendor");
            invoke(
                &cargo,
                root,
                &[
                    "vendor",
                    "--locked",
                    dest.to_str().context("invalid vendor path")?,
                ],
            )
            .await?;
            fs::rename(dest, &vendor)?;
            repairs.push("vendored locked cell dependencies".into());
        }
        if warm_build && !warm.is_file() {
            invoke(
                &cargo,
                root,
                &[
                    "build",
                    "--release",
                    "--offline",
                    "--locked",
                    "--target",
                    "wasm32-wasip1",
                    "-p",
                    "cell",
                ],
            )
            .await?;
            repairs.push("compiled WASI cell template".into());
        }
    }

    Ok(repairs)
}

/// Inspect the installed Cargo toolchain and WasmEdge. With repair enabled,
/// prepare the locked WASI template used for new session workspaces.
pub async fn doctor(fix: bool) -> Result<Value> {
    let cwd = std::env::current_dir()?;
    let cargo = config::program("cargo", "WASMEDGE_AGENT_CARGO");
    let rustup = config::program("rustup", "WASMEDGE_AGENT_RUSTUP");
    let engine = config::program("wasmedge", "WASMEDGE_AGENT_WASMEDGE");
    let mut repairs = Vec::new();
    let mut checks = Vec::new();
    let mut add = |name: &str, out: Result<String>| match out {
        Ok(detail) => checks.push(json!({"name":name,"ok":true,"detail":detail})),
        Err(e) => checks.push(json!({"name":name,"ok":false,"detail":e.to_string()})),
    };
    add("cargo", invoke(&cargo, &cwd, &["--version"]).await);
    let target = async {
        if !rustup.is_file() {
            let rustc = config::program("rustc", "RUSTC");
            let dir = invoke(
                &rustc,
                &cwd,
                &["--print", "target-libdir", "--target", "wasm32-wasip1"],
            )
            .await?;
            ensure!(
                Path::new(&dir).is_dir(),
                "missing wasm32-wasip1 standard library"
            );
        } else if !invoke(&rustup, &cwd, &["target", "list", "--installed"])
            .await?
            .lines()
            .any(|s| s == "wasm32-wasip1")
        {
            ensure!(fix, "wasm32-wasip1 is missing; run doctor --fix");
            invoke(&rustup, &cwd, &["target", "add", "wasm32-wasip1"]).await?;
            repairs.push("added wasm32-wasip1".to_owned());
        }
        Ok("installed".into())
    }
    .await;
    add("wasm32-wasip1 target", target);
    add("wasmedge", invoke(&engine, &cwd, &["--version"]).await);
    let template = config::template();
    add(
        "workspace template",
        template
            .as_ref()
            .map(|p| p.display().to_string())
            .map_err(|e| anyhow::anyhow!("{e}")),
    );
    if let Ok(root) = template {
        let warm = root.join("target/wasm32-wasip1/release/cell.wasm");
        let vendor = root.join("vendor");
        if fix {
            repairs.extend(prepare_template(&root, true).await?);
        }
        add(
            "template vendor",
            if vendor.is_dir() {
                Ok("vendored".into())
            } else {
                Err(anyhow::anyhow!("run doctor --fix to vendor the template"))
            },
        );
        add(
            "template build",
            if warm.is_file() {
                Ok("warm".into())
            } else {
                Err(anyhow::anyhow!("cold; run doctor --fix"))
            },
        );
    }
    Ok(json!({"runtime":checks,"fixes":repairs}))
}

const CATEGORIES: [&str; 7] = [
    "cache",
    "dependencies",
    "state",
    "history",
    "scratch",
    "sources",
    "other",
];
#[cfg(unix)]
fn identity(m: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (m.dev(), m.ino())
}
#[cfg(not(unix))]
fn identity(_: &fs::Metadata) -> (u64, u64) {
    (0, 0)
}
fn usage(path: &Path, device: Option<u64>, counts: &mut [u64; 3]) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    ensure!(
        device.is_none_or(|dev| dev == identity(&m).0),
        "cache crosses a filesystem boundary"
    );
    if m.is_dir() {
        for e in fs::read_dir(path)? {
            usage(&e?.path(), device, counts)?;
        }
    } else if m.is_symlink() || m.is_file() {
        counts[0] += m.len();
        counts[if m.is_symlink() { 2 } else { 1 }] += 1;
    } else {
        bail!("special filesystem entry: {}", path.display());
    }
    Ok(())
}
async fn report(ws: &Path, prune: bool, apply: bool) -> Result<Value> {
    let ws = ws.canonicalize()?;
    let validate = || -> Result<()> {
        for f in [
            "Cargo.toml",
            "agent_lib/Cargo.toml",
            "cell/Cargo.toml",
            "rlm/Cargo.toml",
            ".workspace-version",
        ] {
            ensure!(
                ws.join(f).symlink_metadata()?.is_file(),
                "not a managed Rust cell workspace"
            );
        }
        let version = ws.join(".workspace-version");
        ensure!(
            version.metadata()?.len() < 1024 * 1024,
            "invalid workspace version"
        );
        let stamp: Value = serde_json::from_slice(&fs::read(version)?)?;
        ensure!(
            stamp["schema"] == 1
                && stamp["templateHash"].is_string()
                && stamp["sourceHashes"].is_object(),
            "invalid workspace version"
        );
        Ok(())
    };
    validate()?;
    let _lease = if prune {
        Some(
            tokio::time::timeout(Duration::from_millis(100), workspace::acquire(&ws))
                .await
                .context("workspace is in use")??,
        )
    } else {
        None
    };
    validate()?;
    let target = ws.join("target");
    let metadata = match target.symlink_metadata() {
        Ok(m) => Some(m),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if prune {
        if let Some(m) = &metadata {
            ensure!(
                m.is_dir() && identity(m).0 == identity(&ws.metadata()?).0,
                "cache must be a real local directory"
            );
        }
    }
    let mut buckets = [[0u64; 3]; 7];
    for e in fs::read_dir(&ws)? {
        let e = e?;
        let index = match e.file_name().to_str().unwrap_or("") {
            "target" => 0,
            "vendor" => 1,
            "state" => 2,
            ".git" => 3,
            ".scratch" => 4,
            "agent_lib"
            | "cell"
            | "rlm"
            | "skills"
            | ".cargo"
            | "Cargo.toml"
            | "Cargo.lock"
            | ".workspace-version"
            | ".skills-hash"
            | ".cell-dependencies.json"
            | ".native-prelude.json" => 5,
            _ => 6,
        };
        usage(
            &e.path(),
            (index == 0 && prune).then_some(identity(&ws.metadata()?).0),
            &mut buckets[index],
        )?;
    }
    let categories=CATEGORIES.into_iter().zip(buckets).map(|(category,[logical,files,links])|json!({"category":category,"logicalBytes":logical,"files":files,"symlinks":links})).collect::<Vec<_>>();
    let mut report = json!({"workspace":ws,"logicalBytes":buckets.iter().map(|b|b[0]).sum::<u64>(),"categories":categories});
    if prune {
        let mut applied = false;
        if apply {
            if let Some(m) = metadata {
                let current = target.symlink_metadata()?;
                ensure!(
                    current.is_dir() && identity(&current) == identity(&m),
                    "cache changed during inspection"
                );
                fs::remove_dir_all(&target)?;
                applied = true;
            }
        }
        report["prune"] = json!({"path":target,"logicalBytes":buckets[0][0],"applied":applied});
    }
    Ok(report)
}
fn discover(root: &Path, containers: bool, out: &mut Vec<PathBuf>) -> Result<()> {
    for e in fs::read_dir(root)? {
        let e = e?;
        let n = e.file_name();
        let n = n.to_string_lossy();
        if n.starts_with('.') {
            continue;
        }
        if !containers && n == "workspace" {
            out.push(e.path());
            continue;
        }
        if !e.file_type()?.is_dir() {
            continue;
        }
        if containers || n.starts_with("sub-") || e.path().join("rlm-subagent.json").is_file() {
            discover(&e.path(), false, out)?;
        } else if n == "session-artifacts" {
            discover(&e.path(), true, out)?;
        }
    }
    Ok(())
}
/// Report logical workspace sizes, or remove only the verified build cache
/// when the caller explicitly passes both prune flags.
pub async fn storage(args: &[String]) -> Result<i32> {
    let (mut dir, mut artifacts, mut prune, mut apply, mut json_mode, mut positional) =
        (None, None, false, false, false, false);
    let mut args = args.iter();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--" if !positional => positional = true,
            "--json" if !positional => json_mode = true,
            "--prune-cache" if !positional => prune = true,
            "--apply" if !positional => apply = true,
            "--artifacts" if !positional => {
                ensure!(artifacts.is_none(), "duplicate --artifacts");
                artifacts = Some(PathBuf::from(
                    args.next()
                        .filter(|s| !s.starts_with('-'))
                        .context("missing artifacts path")?,
                ));
            }
            s => {
                ensure!(
                    (positional || !s.starts_with('-')) && dir.is_none(),
                    "unexpected storage argument {s}"
                );
                dir = Some(PathBuf::from(s));
            }
        }
    }
    ensure!(!apply || prune, "--apply requires --prune-cache");
    let output = match (dir, artifacts) {
        (Some(ws), None) => report(&ws, prune, apply).await?,
        (None, Some(root)) => {
            let root = root.canonicalize()?;
            let mut paths = Vec::new();
            discover(&root, true, &mut paths)?;
            paths.sort();
            let mut entries = Vec::new();
            let mut total = 0;
            let mut complete = true;
            for path in paths {
                let r = async {
                    ensure!(
                        path.canonicalize()? == path,
                        "workspace must not be a symlink"
                    );
                    report(&path, prune, apply).await
                }
                .await;
                entries.push(match r{Ok(r)=>{total+=r["logicalBytes"].as_u64().unwrap_or(0);json!({"workspace":path,"status":"ok","report":r})},Err(e)=>{complete=false;json!({"workspace":path,"status":if e.to_string().contains("in use"){"skipped"}else{"error"},"error":e.to_string()})}});
            }
            json!({"artifactsRoot":root,"logicalBytes":total,"complete":complete,"workspaces":entries})
        }
        _ => bail!("storage requires a workspace path or --artifacts <directory>"),
    };
    if json_mode {
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        println!("{} logical bytes", output["logicalBytes"]);
        for row in output["categories"].as_array().into_iter().flatten() {
            println!(
                "  {}: {} bytes",
                row["category"].as_str().unwrap_or(""),
                row["logicalBytes"]
            );
        }
        for entry in output["workspaces"].as_array().into_iter().flatten() {
            println!(
                "  {}: {}",
                entry["workspace"].as_str().unwrap_or(""),
                entry["status"]
            );
        }
        if prune {
            println!(
                "{}",
                if apply {
                    "Cache pruning complete"
                } else {
                    "Cache prune preview; use --apply to remove it"
                }
            );
        }
    }
    Ok(i32::from(output["complete"] == false))
}
