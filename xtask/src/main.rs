mod catalog;
mod checks;
use anyhow::{bail, ensure, Context, Result};
use flate2::{write::GzEncoder, Compression, GzBuilder};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
};
const PLATFORMS: [&str; 5] = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
];
type Archive = tar::Builder<GzEncoder<fs::File>>;
fn archive(path: &Path) -> Result<Archive> {
    Ok(tar::Builder::new(
        GzBuilder::new()
            .mtime(0)
            .write(fs::File::create_new(path)?, Compression::fast()),
    ))
}
fn append(a: &mut Archive, path: &Path, mode: u32, size: u64, reader: impl Read) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_mode(mode);
    header.set_size(size);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_cksum();
    a.append_data(&mut header, path, reader)?;
    Ok(())
}
fn tree(a: &mut Archive, src: &Path, dst: &Path, source: bool) -> Result<()> {
    let meta = src.symlink_metadata()?;
    if meta.is_dir() {
        let mut entries = fs::read_dir(src)?.collect::<io::Result<Vec<_>>>()?;
        entries.sort_by_key(fs::DirEntry::file_name);
        for e in entries {
            let name = e.file_name();
            if name == "target"
                || name == ".git"
                || name == "node_modules"
                || name == ".DS_Store"
                || name == ".template-preparation.lock"
                || source && name == "vendor" && src.ends_with("template")
            {
                continue;
            }
            tree(a, &e.path(), &dst.join(name), source)?;
        }
    } else {
        ensure!(
            meta.is_file(),
            "release input must be a regular file: {}",
            src.display()
        );
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = src.extension().is_some_and(|s| s == "sh" || s == "exe");
        append(
            a,
            dst,
            if executable { 0o755 } else { 0o644 },
            meta.len(),
            fs::File::open(src)?,
        )?;
    }
    Ok(())
}
fn finish(a: Archive, path: &Path) -> Result<String> {
    a.into_inner()?.finish()?.sync_all()?;
    let mut hash = Sha256::new();
    let mut file = fs::File::open(path)?;
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
fn render_installer(template: &str, base: &str, channel: &str, version: &str) -> String {
    template
        .replace("__WASMEDGE_AGENT_DOWNLOAD_BASE_URL__", base)
        .replace("__WASMEDGE_AGENT_DEFAULT_RELEASE_CHANNEL__", channel)
        .replace(
            "__WASMEDGE_AGENT_RENDERED_RELEASE__",
            &format!("v{version}"),
        )
}
fn versioned_manifest(source: &str, name: &str, version: &str) -> Result<String> {
    let mut document: toml::Value = toml::from_str(source)?;
    if name == "Cargo.toml" {
        document["workspace"]["package"]["version"] = version.into();
    } else {
        let packages = document["package"]
            .as_array_mut()
            .context("missing locked packages")?;
        for package in packages {
            if package.get("source").is_none()
                && package["version"].as_str() == Some(env!("CARGO_PKG_VERSION"))
            {
                package["version"] = version.into();
            }
        }
    }
    Ok(toml::to_string_pretty(&document)?)
}
fn pack(root: &Path, args: &[String]) -> Result<()> {
    let mut args = args.iter();
    let mut options = BTreeMap::new();
    while let Some(key) = args.next() {
        ensure!(
            [
                "--channel",
                "--version",
                "--base-url",
                "--out-dir",
                "--hosts",
                "--platform"
            ]
            .contains(&key.as_str()),
            "unknown option {key}"
        );
        ensure!(
            options
                .insert(key.as_str(), args.next().context("missing value")?.as_str())
                .is_none(),
            "duplicate {key}"
        );
    }
    let channel = options.get("--channel").copied().unwrap_or("stable");
    ensure!(matches!(channel, "stable" | "beta"), "invalid channel");
    let version = options
        .get("--version")
        .copied()
        .unwrap_or(env!("CARGO_PKG_VERSION"));
    semver::Version::parse(version)?;
    ensure!(!version.contains('+'), "unsupported build metadata");
    let base = *options
        .get("--base-url")
        .context("release requires --base-url")?;
    let url = url::Url::parse(base)?;
    ensure!(
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && base
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-.:/_~".contains(&c)),
        "invalid HTTPS release base"
    );
    let tracked = checks::tracked(root)?;
    let hosts = root.join(
        options
            .get("--hosts")
            .copied()
            .unwrap_or("target/release-hosts"),
    );
    let out = root.join(options.get("--out-dir").copied().unwrap_or("target/dist"));
    fs::create_dir_all(&out)?;
    let dest = out.join("artifacts");
    ensure!(!dest.exists(), "output already exists: {}", dest.display());
    let stage = tempfile::tempdir_in(&out)?;
    let dir = stage.path();
    let mut binaries = Vec::new();
    let mut sums = BTreeMap::new();
    let template = root.join("wasmedge-agent-runtime/template");
    ensure!(
        template.join("vendor").is_dir(),
        "vendor the locked guest template before packing"
    );
    let selected = options.get("--platform").copied();
    ensure!(
        selected.is_none_or(|s| PLATFORMS.contains(&s)),
        "unsupported platform"
    );
    for platform in PLATFORMS
        .into_iter()
        .filter(|s| selected.is_none_or(|choice| choice == *s))
    {
        let binary = if platform == "win32-x64" {
            "wasmedge-agent.exe"
        } else {
            "wasmedge-agent"
        };
        let host = hosts.join(platform).join(binary);
        let file = format!("wasmedge-agent-{version}-{platform}.tar.gz");
        let path = dir.join(&file);
        let mut a = archive(&path)?;
        let fd = fs::File::open(&host)
            .with_context(|| format!("missing release binary {}", host.display()))?;
        append(&mut a, Path::new(binary), 0o755, fd.metadata()?.len(), fd)?;
        for name in &tracked {
            let rel = Path::new(name);
            if [
                "LICENSE",
                "README.md",
                "catalog",
                "skills",
                "wasmedge-agent-runtime",
            ]
            .iter()
            .any(|dir| rel.starts_with(dir))
            {
                tree(&mut a, &root.join(rel), rel, false)?;
            } else if let Ok(doc) = rel.strip_prefix("packages/coding-agent/docs") {
                tree(&mut a, &root.join(rel), &Path::new("docs").join(doc), false)?;
            }
        }
        tree(
            &mut a,
            &template.join("vendor"),
            Path::new("wasmedge-agent-runtime/template/vendor"),
            false,
        )?;
        let stamp = serde_json::to_vec_pretty(
            &json!({"version":version,"channel":channel,"platform":platform,"downloadBaseUrl":base}),
        )?;
        append(
            &mut a,
            Path::new("version.json"),
            0o644,
            stamp.len() as u64,
            stamp.as_slice(),
        )?;
        let sha = finish(a, &path)?;
        binaries.push(json!({"platform":platform,"file":file,"sha256":sha}));
        sums.insert(file, sha);
    }
    let sdk = format!("wasmedge-agent-sdk-{version}.tar.gz");
    let sdk_path = dir.join(&sdk);
    let prefix = PathBuf::from(format!("wasmedge-agent-sdk-{version}"));
    let mut a = archive(&sdk_path)?;
    for name in &tracked {
        let path = Path::new(name);
        if ![
            ".cargo",
            "Cargo.toml",
            "Cargo.lock",
            "LICENSE",
            "README.md",
            "install.sh",
            "crates",
            "xtask",
            "vendor",
            "catalog",
            "skills",
            "wasmedge-agent-runtime",
            "packages/coding-agent/docs/sdk.md",
        ]
        .iter()
        .any(|dir| path.starts_with(dir))
        {
            continue;
        }
        let dest = prefix.join(path);
        if matches!(name.as_str(), "Cargo.toml" | "Cargo.lock")
            && version != env!("CARGO_PKG_VERSION")
        {
            let source = fs::read_to_string(root.join(path))?;
            let rendered = versioned_manifest(&source, name, version)?;
            append(
                &mut a,
                &dest,
                0o644,
                rendered.len() as u64,
                rendered.as_bytes(),
            )?;
        } else {
            tree(&mut a, &root.join(path), &dest, false)?;
        }
    }
    tree(
        &mut a,
        &template.join("vendor"),
        &prefix.join("wasmedge-agent-runtime/template/vendor"),
        false,
    )?;
    let hash = finish(a, &sdk_path)?;
    sums.insert(sdk.clone(), hash.clone());
    let release = json!({"version":format!("v{version}"),"binaries_v2":binaries,"sdk":{"file":sdk,"sha256":hash}});
    let manifest = serde_json::to_vec_pretty(&release)?;
    fs::write(dir.join("release.json"), &manifest)?;
    fs::write(dir.join(channel), format!("v{version}\n"))?;
    fs::write(
        dir.join("SHA256SUMS"),
        sums.iter()
            .map(|(file, sha)| format!("{sha}  {file}\n"))
            .collect::<String>(),
    )?;
    let installer = render_installer(
        &fs::read_to_string(root.join("install.sh"))?,
        base,
        channel,
        version,
    );
    fs::write(dir.join("install.sh"), installer)?;
    if channel == "stable" {
        fs::write(dir.join("latest.json"), manifest)?;
    }
    fs::rename(dir, &dest)?;
    println!("{}", dest.display());
    Ok(())
}
fn check(root: &Path) -> Result<()> {
    let files = checks::tracked(root)?;
    checks::branding(root, &files)?;
    checks::reports(root, &files)?;
    catalog::refresh(root, &[])?;
    for args in [
        &["fmt", "--all", "--check"][..],
        &["check", "--locked", "--workspace", "--all-targets"][..],
    ] {
        ensure!(
            Command::new("cargo")
                .args(args)
                .current_dir(root)
                .status()?
                .success(),
            "cargo {} failed",
            args.join(" ")
        );
    }
    Ok(())
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .context("missing workspace")?;
    match args.first().map(String::as_str) {
        Some("pack") => pack(root,&args[1..]),
        Some("branding") => checks::branding(root,&checks::tracked(root)?),
        Some("reports") => checks::reports(root,&checks::tracked(root)?),
        Some("catalog") => catalog::refresh(root,&args[1..]),
        Some("check") => check(root),
        Some("version") => {println!("{}",env!("CARGO_PKG_VERSION"));Ok(())}
        _ => bail!("usage: xtask check | branding | reports | catalog [SOURCE] | pack --base-url URL | version"),
    }
}
