use super::{config, guest::Guest, process, rustdoc, sandbox, workspace};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs};

pub(super) async fn query(g: &Guest<'_>, p: &Value) -> Result<Value> {
    let toolchain = g
        .config
        .rustdoc_toolchain
        .as_deref()
        .filter(|s| {
            !s.is_empty()
                && !s.starts_with('-')
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        })
        .context("api.describe requires an installed rustCell.rustdocToolchain")?;
    let path = p["path"].as_str().context("missing API path")?;
    ensure!(
        path.len() <= 512
            && !path.chars().any(char::is_control)
            && matches!(path.split("::").next(), Some("agent_lib" | "rlm")),
        "invalid API path"
    );
    let list = p["mode"] == "list";
    ensure!(list || p["mode"] == "describe", "invalid query mode");
    let offset = p
        .get("offset")
        .map(Value::as_u64)
        .unwrap_or(Some(0))
        .context("invalid offset")? as usize;
    ensure!(list || offset == 0, "offset applies only to lists");
    let version = process::run(
        {
            let mut cmd =
                process::command(config::program("rustup", "WASMEDGE_AGENT_RUSTUP"), g.ws);
            cmd.args(["run", toolchain, "rustc", "--version", "--verbose"])
                .env("RUSTUP_AUTO_INSTALL", "0");
            cmd
        },
        None,
    )
    .await?
    .require("rustdoc toolchain")?
    .stdout;
    let fingerprint = workspace::fingerprint(g.ws)?;
    let cache = g.ws.join("target/native-rustdoc.json");
    let key = json!([1, toolchain, version, fingerprint, g.config.bwrap()]);
    let existing = fs::read(&cache)
        .ok()
        .and_then(|s| serde_json::from_slice::<Value>(&s).ok());
    let items = if let Some(hit) = existing.filter(|v| v["key"] == key) {
        hit["items"].clone()
    } else {
        let dir = tempfile::tempdir()?;
        let ws = dir.path().join("workspace");
        workspace::snapshot(g.ws, &ws)?;
        ensure!(
            workspace::fingerprint(&ws)? == fingerprint,
            "sources changed during documentation snapshot"
        );
        let mut names = vec!["agent_lib".to_owned(), "rlm".to_owned()];
        if ws.join("skills").is_dir() {
            for entry in fs::read_dir(ws.join("skills"))? {
                let entry = entry?;
                if entry.path().join("Cargo.toml").is_file() {
                    names.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
        }
        let mut args = vec![
            "doc",
            "--release",
            "--offline",
            "--locked",
            "--target",
            "wasm32-wasip1",
            "--no-deps",
            "--lib",
        ];
        for n in &names {
            args.extend(["-p", n]);
        }
        let mut cmd = sandbox::cargo(&ws, g.config, g.resources, &args, None)?;
        cmd.env_remove("RUSTC")
            .env("RUSTUP_TOOLCHAIN", toolchain)
            .env("RUSTUP_AUTO_INSTALL", "0")
            .env("RUSTDOCFLAGS", "-Z unstable-options --output-format=json");
        sandbox::build(cmd)
            .await?
            .require("generating rustdoc JSON")?;
        let mut docs = BTreeMap::new();
        for name in names {
            let file =
                sandbox::target(&ws, g.config).join(format!("wasm32-wasip1/doc/{name}.json"));
            ensure!(
                file.metadata()?.len() <= 32 * 1024 * 1024,
                "rustdoc output exceeds limit"
            );
            let doc: Value = serde_json::from_slice(&fs::read(file)?)?;
            docs.insert(name, doc);
        }
        let items = rustdoc::build(&docs)?;
        ensure!(
            workspace::fingerprint(g.ws)? == fingerprint
                && workspace::fingerprint(&ws)? == fingerprint,
            "sources changed while documenting"
        );
        let data = serde_json::to_vec(&json!({"key":key,"items":items}))?;
        ensure!(
            data.len() <= 32 * 1024 * 1024,
            "rustdoc cache exceeds limit"
        );
        workspace::atomic(&cache, &data)?;
        items
    };
    let prefix = format!("{path}::");
    let matches = items
        .as_array()
        .context("invalid API cache")?
        .iter()
        .filter(|item| {
            item["path"]
                .as_str()
                .is_some_and(|k| k == path || list && k.starts_with(&prefix))
        })
        .collect::<Vec<_>>();
    ensure!(!matches.is_empty(), "no documented public API at {path}");
    let total = matches.len();
    let mut entries = Vec::new();
    let mut bytes = 0;
    for v in matches
        .into_iter()
        .skip(offset)
        .take(if list { 50 } else { usize::MAX })
    {
        let entry = if list {
            json!({"path":v["path"],"kind":v["kind"]})
        } else {
            let mut entry = v.clone();
            if let Some(docs) = v["docs"].as_str().filter(|s| s.chars().count() > 8000) {
                entry["docs"] = docs.chars().take(8000).collect::<String>().into();
                entry["docsTruncated"] = true.into();
            }
            entry
        };
        bytes += serde_json::to_vec(&entry)?.len();
        if bytes > 32_000 {
            ensure!(
                list && !entries.is_empty(),
                "API declaration exceeds response limit"
            );
            break;
        }
        entries.push(entry);
    }
    let next = offset.saturating_add(entries.len());
    Ok(
        json!({"source":"rustdoc-json","target":"wasm32-wasip1","cfg":["doc"],"toolchain":toolchain,"rustcVersion":version.trim(),"formatVersion":61,"path":path,"items":entries,"total":total,"nextOffset":(next<total).then_some(next)}),
    )
}
