use super::process;
use anyhow::{bail, ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};
pub(super) const SEED: &str = ".rust-workspace-seed";
pub(super) const PATHS: &[&str] = &[
    ".workspace-version",
    ".native-prelude.json",
    ".cell-dependencies.json",
    ".cargo",
    "Cargo.toml",
    "Cargo.lock",
    "agent_lib",
    "cell/Cargo.toml",
    "rlm",
    "skills",
    "target",
    "vendor",
];
pub(super) fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("missing file parent")?;
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.persist(path)?;
    Ok(())
}
pub(super) fn physical(path: &Path) -> Result<PathBuf> {
    match path.canonicalize() {
        Ok(p) => Ok(p),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().context("invalid unresolved path")?;
            Ok(physical(parent)?.join(path.file_name().context("invalid path")?))
        }
        Err(e) => Err(e.into()),
    }
}
pub(super) fn overlap(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}
pub(super) fn names(p: &Path) -> Result<Vec<std::ffi::OsString>> {
    let mut out = fs::read_dir(p)?
        .map(|e| e.map(|x| x.file_name()))
        .collect::<std::io::Result<Vec<_>>>()?;
    out.sort();
    Ok(out)
}
fn copy(src: &Path, dst: &Path, root: &Path, chain: &mut BTreeSet<PathBuf>) -> Result<()> {
    let meta = src.metadata()?;
    if meta.is_dir() {
        let absolute = src.canonicalize()?;
        ensure!(
            chain.insert(absolute.clone()),
            "recursive workspace link at {}",
            src.display()
        );
        fs::create_dir_all(dst)?;
        for n in names(src)? {
            if n == ".git" || (n == "target" && dst != root && dst.parent() != Some(root)) {
                continue;
            }
            copy(&src.join(&n), &dst.join(&n), root, chain)?;
        }
        chain.remove(&absolute);
    } else if meta.is_file() {
        fs::create_dir_all(dst.parent().context("copy parent")?)?;
        fs::copy(src, dst)
            .with_context(|| format!("copying {} to {}", src.display(), dst.display()))?;
        if let Ok(modified) = meta.modified() {
            fs::File::open(dst)?
                .set_modified(modified)
                .with_context(|| format!("setting mtime on {}", dst.display()))?;
        }
    } else {
        bail!("unsupported workspace file {}", src.display());
    }
    Ok(())
}
pub(super) fn copy_entry(src: &Path, dst: &Path) -> Result<()> {
    copy(src, dst, dst, &mut BTreeSet::new())
}
pub(super) fn snapshot(src: &Path, dest: &Path) -> Result<()> {
    let parent = dest.parent().context("snapshot parent")?;
    fs::create_dir_all(parent)?;
    ensure!(!dest.exists(), "workspace snapshot already exists");
    let stage = tempfile::Builder::new()
        .prefix(".workspace-snapshot-")
        .tempdir_in(parent)?;
    for n in PATHS {
        let input = src.join(n);
        if input.try_exists()? {
            copy(
                &input,
                &stage.path().join(n),
                stage.path(),
                &mut BTreeSet::new(),
            )?;
        }
    }
    atomic(&stage.path().join("cell/src/main.rs"), b"fn main() {}\n")?;
    atomic(&stage.path().join(".inherited-workspace"), b"1\n")?;
    fs::rename(stage.path(), dest)?;
    Ok(())
}
pub(super) struct Lease {
    directory: PathBuf,
    token: String,
}
struct Guard(PathBuf);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}
fn guard(directory: &Path) -> Result<Option<Guard>> {
    let lock = directory.with_extension("lock.guard");
    match fs::create_dir(&lock) {
        Ok(()) => Ok(Some(Guard(lock))),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // The legacy lease guard is an empty directory with a five-second heartbeat.
            if let Ok(metadata) = fs::symlink_metadata(&lock) {
                if metadata.is_dir()
                    && metadata
                        .modified()?
                        .elapsed()
                        .is_ok_and(|age| age > Duration::from_secs(5))
                {
                    let _ = fs::remove_dir(&lock);
                }
            }
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        // Other writers cannot reclaim a record with our live process identity.
        // Remove the token we own only. Rename it away before removing its files.
        let owner = self.directory.join("owner.json");
        let owned = fs::read(owner)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .is_some_and(|v| v["token"] == self.token);
        if owned {
            let retired = self
                .directory
                .with_extension(format!("released-{}", self.token));
            if fs::rename(&self.directory, &retired).is_ok() {
                let _ = fs::remove_dir_all(retired);
            }
        }
    }
}
pub(super) async fn acquire(ws: &Path) -> Result<Lease> {
    let dir = ws
        .parent()
        .context("workspace missing parent")?
        .join(".rust-cell-locks/session-leases");
    fs::create_dir_all(&dir)?;
    let path = physical(ws)?;
    let digest = hex::encode(Sha256::digest(path.to_string_lossy().as_bytes()));
    let directory = dir.join(format!("{digest}.lock"));
    let deadline = std::time::Instant::now() + Duration::from_secs(300);
    loop {
        if let Some(_guard) = guard(&directory)? {
            if directory.exists() {
                let bytes = match fs::read(directory.join("owner.json")) {
                    Ok(bytes) => bytes,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound && !directory.exists() => {
                        continue
                    }
                    Err(e) => return Err(e.into()),
                };
                let owner: serde_json::Value = serde_json::from_slice(&bytes)?;
                let pid = owner["pid"]
                    .as_u64()
                    .and_then(|n| u32::try_from(n).ok())
                    .filter(|n| *n > 0)
                    .context("invalid workspace lease owner")?;
                let alive = pa_types::platform::process::is_process_alive(pid)?;
                let replaced = owner["processStartId"]
                    .as_str()
                    .zip(pa_types::platform::process::process_start_id(pid))
                    .is_some_and(|(prior, now)| prior != now);
                if !alive || replaced {
                    let stale = dir.join(format!(".stale-{}", uuid::Uuid::new_v4()));
                    fs::rename(&directory, &stale)?;
                    fs::remove_dir_all(stale)?;
                }
            }
            if !directory.exists() {
                let token = uuid::Uuid::new_v4().to_string();
                let pid = std::process::id();
                let stage = tempfile::tempdir_in(&dir)?;
                let mut owner = serde_json::json!({"version":1,"pid":pid,"token":token,"sessionPath":path,"createdAt":crate::session::manager::format_iso_now()});
                if let Some(id) = pa_types::platform::process::process_start_id(pid) {
                    owner["processStartId"] = id.into();
                }
                atomic(
                    &stage.path().join("owner.json"),
                    &serde_json::to_vec(&owner)?,
                )?;
                fs::rename(stage.path(), &directory)?;
                return Ok(Lease { directory, token });
            }
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "workspace is in use: {}",
            ws.display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
pub(super) struct Changes {
    files: BTreeMap<PathBuf, Option<Vec<u8>>>,
    done: bool,
}
impl Changes {
    pub fn new() -> Self {
        Self {
            files: BTreeMap::new(),
            done: false,
        }
    }
    pub fn write(&mut self, path: PathBuf, bytes: &[u8]) -> Result<()> {
        if let std::collections::btree_map::Entry::Vacant(entry) = self.files.entry(path.clone()) {
            entry.insert(match fs::read(&path) {
                Ok(b) => Some(b),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.into()),
            });
        }
        atomic(&path, bytes)
    }
    pub fn commit(mut self) {
        self.done = true;
    }
}
impl Drop for Changes {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        for (path, bytes) in &self.files {
            let restored = match bytes {
                Some(b) => atomic(path, b),
                None => fs::remove_file(path).map_err(Into::into),
            };
            if let Err(e) = restored {
                tracing::error!("failed to restore {}: {e}", path.display());
            }
        }
    }
}
pub(super) fn lib_edits(
    ws: &Path,
    edits: &[serde_json::Value],
    txn: &mut Changes,
) -> Result<Vec<serde_json::Value>> {
    let root = ws.join("agent_lib").canonicalize()?;
    let mut changes = Vec::new();
    let mut index = false;
    for item in edits {
        let name = item["path"].as_str().context("lib edit requires a path")?;
        let path = Path::new(name);
        ensure!(
            path.starts_with("src")
                && path.components().all(|c| matches!(c, Component::Normal(_)))
                && path.extension().is_some_and(|e| e == "rs"),
            "lib path must be a Rust file under src/: {name}"
        );
        let dst = root.join(path);
        ensure!(
            physical(&dst)?.starts_with(&root),
            "lib edit escapes agent_lib"
        );
        if path == Path::new("src/helpers/mod.rs") {
            index = true;
        }
        let content = item["content"]
            .as_str()
            .context("lib edit requires content")?;
        let before = fs::read_to_string(&dst).unwrap_or_default();
        txn.write(dst, content.as_bytes())?;
        changes.push(serde_json::json!({"path":format!("agent_lib/{name}"),"oldStr":before,"newStr":content}));
    }
    let helpers = root.join("src/helpers");
    if !index && !edits.is_empty() && helpers.is_dir() {
        ensure!(
            physical(&helpers)?.starts_with(&root),
            "helpers directory escapes agent_lib"
        );
        let mut body = String::from("//! Model-added helper modules.\n");
        for entry in names(&helpers)? {
            let p = PathBuf::from(entry);
            if p.extension().is_some_and(|e| e == "rs") && p.file_stem().is_some_and(|e| e != "mod")
            {
                body.push_str(&format!(
                    "pub mod {};\n",
                    p.file_stem().unwrap().to_string_lossy()
                ));
            }
        }
        txn.write(helpers.join("mod.rs"), body.as_bytes())?;
    }
    Ok(changes)
}
pub(super) fn fingerprint(root: &Path) -> Result<String> {
    fn visit(
        root: &Path,
        rel: &Path,
        hash: &mut Sha256,
        seen: &mut BTreeSet<PathBuf>,
    ) -> Result<()> {
        let p = root.join(rel);
        let meta = p.metadata()?;
        if meta.is_dir() {
            let abs = p.canonicalize()?;
            ensure!(seen.insert(abs.clone()), "source contains cyclic directory");
            for n in names(&p)? {
                if !["target", "vendor", ".git", "state", ".scratch"]
                    .iter()
                    .any(|x| n == *x)
                {
                    visit(root, &rel.join(n), hash, seen)?;
                }
            }
            seen.remove(&abs);
        } else if meta.is_file() {
            hash.update(rel.as_os_str().as_encoded_bytes());
            hash.update([0]);
            let mut f = fs::File::open(&p)?;
            let mut buffer = [0u8; 16384];
            loop {
                let n = f.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
            }
            hash.update([0]);
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    for path in [
        "Cargo.toml",
        "Cargo.lock",
        ".cargo",
        "rlm",
        "agent_lib",
        "skills",
    ] {
        if root.join(path).exists() {
            visit(root, Path::new(path), &mut hash, &mut BTreeSet::new())?;
        }
    }
    Ok(hex::encode(hash.finalize()))
}
pub(super) async fn history(ws: &Path, subject: &str) -> Result<String> {
    async fn git(ws: &Path, args: &[&str]) -> Result<String> {
        let mut cmd = process::command("git", ws);
        cmd.env("GIT_CONFIG_NOSYSTEM", "1").env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
        cmd.args([
            "-c",
            "user.name=WasmEdge Agent",
            "-c",
            "user.email=agent@localhost",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "gc.autoDetach=false",
            "-c",
            "maintenance.autoDetach=false",
        ])
        .args(args);
        Ok(process::run(cmd, None)
            .await?
            .require("workspace Git")?
            .stdout
            .trim()
            .to_string())
    }
    let repo = ws.join(".git");
    if let Ok(meta) = repo.symlink_metadata() {
        ensure!(
            meta.is_dir() && !meta.is_symlink(),
            "invalid workspace .git"
        );
    }
    git(ws, &["init", "--quiet", "--template="]).await?;
    if !ws.join(".gitignore").exists() {
        atomic(&ws.join(".gitignore"), b"/target/\n/vendor/\n/.scratch/\n")?;
    }
    let mut args = vec!["add", "-A", "--"];
    for n in [
        ".gitignore",
        ".workspace-version",
        ".cell-dependencies.json",
        ".cargo",
        "Cargo.toml",
        "Cargo.lock",
        "agent_lib",
        "cell",
        "rlm",
        "skills",
        "state",
    ] {
        if ws.join(n).exists() {
            args.push(n);
        }
    }
    git(ws, &args).await?;
    git(ws, &["commit", "--quiet", "--allow-empty", "-m", subject]).await?;
    git(ws, &["rev-parse", "HEAD"]).await
}
