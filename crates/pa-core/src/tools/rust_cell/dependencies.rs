use super::{guest::Guest, sandbox, skills, workspace};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub(super) const RESERVED:&str="rlm agent_lib cell anyhow regex serde serde_json walkdir std core alloc proc_macro as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try gen";
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Extra {
    name: String,
    version: String,
    #[serde(default)]
    features: Vec<String>,
    #[serde(default = "yes")]
    default_features: bool,
}
fn yes() -> bool {
    true
}
fn catalog() -> BTreeMap<String, String> {
    serde_json::from_str(include_str!("dependencies.json")).expect("built-in crate catalog")
}
fn names(ws: &Path) -> Result<BTreeSet<String>> {
    let file = ws.join(".cell-dependencies.json");
    if !file.try_exists()? {
        return Ok(BTreeSet::new());
    }
    ensure!(
        file.symlink_metadata()?.is_file(),
        "invalid dependency record"
    );
    Ok(serde_json::from_slice(&fs::read(file)?)?)
}
fn extras(guest: &Guest<'_>, names: &BTreeSet<String>) -> Result<BTreeMap<String, Extra>> {
    let mut entries = BTreeMap::new();
    let catalog = catalog();
    for value in &guest.config.prelude_extra {
        let mut item: Extra = serde_json::from_value(value.clone())?;
        let key = item.name.replace('-', "_");
        ensure!(
            item.name.len() <= 64
                && item.name.starts_with(|c: char| c.is_ascii_lowercase())
                && item.name.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'-'
                    || b == b'_')
                && !RESERVED.split_whitespace().any(|s| s == key),
            "invalid prelude crate name"
        );
        let parts: Vec<_> = item.version.split('.').collect();
        ensure!(
            parts.len() == 3
                && parts.iter().all(|s| !s.is_empty()
                    && (s.len() == 1 || !s.starts_with('0'))
                    && s.bytes().all(|b| b.is_ascii_digit())),
            "preludeExtra requires an exact version"
        );
        ensure!(
            item.features.iter().all(|s| !s.is_empty()
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))),
            "invalid prelude feature"
        );
        item.features.sort();
        item.features.dedup();
        ensure!(
            entries.insert(key, item).is_none(),
            "duplicate prelude crate"
        );
    }
    for name in names {
        let version = catalog.get(name).context("unknown curated crate")?;
        entries
            .entry(name.replace('-', "_"))
            .or_insert_with(|| Extra {
                name: name.clone(),
                version: version.clone(),
                features: vec![],
                default_features: true,
            });
    }
    Ok(entries)
}
async fn update(guest: &Guest<'_>, names: &BTreeSet<String>) -> Result<()> {
    let extras = extras(guest, names)?;
    let expected = serde_json::to_vec(&extras)?;
    let marker = guest.ws.join(".native-prelude.json");
    if fs::read(&marker).ok().as_ref() == Some(&expected) {
        return Ok(());
    }
    if extras.is_empty() && !marker.exists() && !guest.ws.join(".cell-dependencies.json").exists() {
        let existing = fs::read_to_string(guest.ws.join("agent_lib/src/prelude_extra.rs"))?;
        if !existing
            .lines()
            .any(|l| l.trim_start().starts_with("pub use "))
        {
            return Ok(());
        }
    }
    let base = guest.ws.parent().context("workspace directory")?;
    let transaction = tempfile::Builder::new()
        .prefix(".cell-deps-")
        .tempdir_in(base)?;
    let staged = transaction.path().join("workspace");
    workspace::snapshot(guest.ws, &staged)?;
    workspace::atomic(
        &staged.join("cell/src/main.rs"),
        &fs::read(guest.ws.join("cell/src/main.rs"))?,
    )?;
    for rel in ["Cargo.toml", "agent_lib/Cargo.toml"] {
        fs::copy(super::config::template()?.join(rel), staged.join(rel))?;
    }
    skills::sync(&guest.runtime.session, &staged)?;
    let mut root = fs::read_to_string(staged.join("Cargo.toml"))?;
    let mut lib = fs::read_to_string(staged.join("agent_lib/Cargo.toml"))?;
    let mut reexports = String::from("//! Operator-configured and curated dependencies.\n");
    for (key, e) in extras {
        ensure!(
            !staged.join("skills").join(&key).exists(),
            "crate conflicts with a mounted skill: {key}"
        );
        let decl = format!(
            "{} = {{ version = \"={}\", default-features = {}, features = {} }}",
            e.name,
            e.version,
            e.default_features,
            serde_json::to_string(&e.features)?
        );
        root = root.replacen(
            "[workspace.dependencies]\n",
            &format!("[workspace.dependencies]\n{decl}\n"),
            1,
        );
        lib = lib.replacen(
            "[dependencies]\n",
            &format!("[dependencies]\n{} = {{ workspace = true }}\n", e.name),
            1,
        );
        reexports.push_str(&format!("pub use {key};\n"));
    }
    for (file, body) in [
        ("Cargo.toml", root),
        ("agent_lib/Cargo.toml", lib),
        ("agent_lib/src/prelude_extra.rs", reexports),
    ] {
        workspace::atomic(&staged.join(file), body.as_bytes())?;
    }
    let vendor = staged.join("vendor.tmp-native");
    sandbox::build(sandbox::cargo(
        &staged,
        guest.config,
        guest.resources,
        &["vendor", "vendor.tmp-native"],
        Some(&vendor),
    )?)
    .await?
    .require("vendoring cell dependencies")?;
    fs::rename(
        staged.join("vendor"),
        transaction.path().join("template-vendor"),
    )?;
    fs::rename(&vendor, staged.join("vendor"))?;
    sandbox::build(sandbox::cargo(
        &staged,
        guest.config,
        guest.resources,
        &["build", "--release", "--offline", "--locked", "-p", "cell"],
        None,
    )?)
    .await?
    .require("validating cell dependencies")?;
    let mut changes = workspace::Changes::new();
    for rel in [
        "Cargo.toml",
        "Cargo.lock",
        "agent_lib/Cargo.toml",
        "agent_lib/src/prelude_extra.rs",
    ] {
        changes.write(guest.ws.join(rel), &fs::read(staged.join(rel))?)?;
    }
    changes.write(
        guest.ws.join(".cell-dependencies.json"),
        &serde_json::to_vec(names)?,
    )?;
    changes.write(marker, &expected)?;
    let previous = transaction.path().join("previous-vendor");
    fs::rename(guest.ws.join("vendor"), &previous)?;
    if let Err(e) = fs::rename(staged.join("vendor"), guest.ws.join("vendor")) {
        fs::rename(previous, guest.ws.join("vendor"))?;
        return Err(e.into());
    }
    changes.commit();
    Ok(())
}
pub(super) async fn configure(guest: &Guest<'_>) -> Result<()> {
    update(guest, &names(guest.ws)?).await
}
pub(super) async fn add(guest: &Guest<'_>, payload: &Value) -> Result<Value> {
    ensure!(
        payload
            .as_object()
            .is_some_and(|v| v.keys().all(|k| k == "crate_name")),
        "deps.add accepts only crate_name"
    );
    let name = payload["crate_name"]
        .as_str()
        .context("missing crate_name")?;
    ensure!(
        catalog().contains_key(name),
        "deps.add requires a curated crate name"
    );
    let mut selected = names(guest.ws)?;
    if extras(guest, &selected)?.contains_key(&name.replace('-', "_")) {
        return Ok(json!({"already_available":true}));
    }
    selected.insert(name.to_owned());
    update(guest, &selected).await?;
    Ok(
        json!({"already_available":false,"crate_name":name,"rust_use":format!("extra::{}",name.replace('-',"_"))}),
    )
}
