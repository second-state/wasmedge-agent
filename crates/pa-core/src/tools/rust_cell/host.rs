pub(super) use super::dependencies::configure;
pub(super) use super::harness::revalidate;
use super::{guest::Guest, skills, workspace, PARENT_CELL};
use crate::kernel::shared::HostRequestPayload;
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{fs, io::Cursor, time::Duration};

pub(super) fn attachment(mime: &str, data: &str, path: Option<&Value>) -> Result<Value> {
    let mut output = data.to_owned();
    let mut mime = mime.to_owned();
    if mime.starts_with("image/") && mime != "image/svg+xml" {
        let bytes = STANDARD.decode(data)?;
        let reader =
            image::ImageReader::new(Cursor::new(bytes.as_slice())).with_guessed_format()?;
        let (w, h) = reader.into_dimensions()?;
        ensure!(
            u64::from(w) * u64::from(h) <= 64_000_000,
            "attachment is too large to decode"
        );
        if w > 1200 || h > 1200 || output.len() > 350_000 {
            let mut img = image::load_from_memory(&bytes)?.thumbnail(1200, 1200);
            loop {
                let mut png = Cursor::new(Vec::new());
                img.write_to(&mut png, image::ImageFormat::Png)?;
                output = STANDARD.encode(png.into_inner());
                mime = "image/png".into();
                if output.len() <= 350_000 || img.width().min(img.height()) <= 1 {
                    break;
                }
                img = img.thumbnail((img.width() * 3 / 4).max(1), (img.height() * 3 / 4).max(1));
            }
        }
    }
    ensure!(
        output.len() <= 350_000,
        "attachment exceeds context size after resizing"
    );
    let mut value = json!({"data":output,"mimeType":mime});
    if let Some(p) = path.and_then(Value::as_str) {
        value["path"] = json!(p);
    }
    Ok(value)
}
fn package(g: &Guest<'_>, p: &Value) -> Result<Value> {
    ensure!(
        p.as_object().is_some_and(|m| m.keys().all(|s| matches!(
            s.as_str(),
            "name" | "description" | "instructions" | "source"
        ))),
        "unknown skills.package field"
    );
    let field = |key: &str, max| {
        p[key]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= max)
            .with_context(|| format!("invalid skill {key}"))
    };
    let name = field("name", 64)?;
    ensure!(
        regex::Regex::new("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")?.is_match(name),
        "invalid skill name"
    );
    let krate = name.replace('-', "_");
    ensure!(
        !super::dependencies::RESERVED
            .split_whitespace()
            .any(|s| s == krate),
        "reserved skill name"
    );
    ensure!(
        !g.ws.join("skills").join(&krate).exists()
            && !g
                .runtime
                .session
                .skills
                .iter()
                .filter_map(|p| p.parent()?.file_name()?.to_str())
                .any(|n| n.replace('-', "_") == krate),
        "skill already loaded"
    );
    let description = field("description", 1024)?;
    let instructions = field("instructions", 65536)?;
    let source = field("source", 262144)?;
    let cwd = g.runtime.session.cwd.canonicalize()?;
    let skills = pa_types::platform::dirs::project_config_dir(&cwd).join("skills");
    let rel = skills.strip_prefix(&cwd)?;
    let mut safe = cwd.clone();
    for c in rel.components() {
        ensure!(
            matches!(c, std::path::Component::Normal(_)),
            "invalid skill path"
        );
        safe.push(c);
        if let Err(e) = fs::create_dir(&safe) {
            ensure!(
                e.kind() == std::io::ErrorKind::AlreadyExists,
                "cannot create skill path: {e}"
            );
        }
        ensure!(
            safe.symlink_metadata()?.is_dir(),
            "skill directory must not be a symlink"
        );
    }
    let dir = skills.join(name);
    fs::create_dir(&dir)?;
    let write = || -> Result<()> {
        let mut manifest=format!("[package]\nname = \"{krate}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\n");
        for dep in ["rlm", "anyhow", "regex", "serde", "serde_json", "walkdir"] {
            manifest.push_str(&format!("{dep} = {{ workspace = true }}\n"));
        }
        workspace::atomic(&dir.join("Cargo.toml"), manifest.as_bytes())?;
        workspace::atomic(&dir.join("src/lib.rs"), source.as_bytes())?;
        workspace::atomic(
            &dir.join("SKILL.md"),
            format!(
                "---\nname: {}\ndescription: {}\n---\n\n{instructions}\n",
                json!(name),
                json!(description)
            )
            .as_bytes(),
        )
    };
    if let Err(e) = write() {
        fs::remove_dir_all(&dir)?;
        return Err(e);
    }
    Ok(
        json!({"path":format!("/workspace/{}",dir.strip_prefix(cwd)?.to_string_lossy().replace('\\',"/")),"crate_name":krate,"rust_use":format!("agent_lib::skills::{krate}"),"requires_reload":true}),
    )
}
async fn search(g: &Guest<'_>, p: &Value) -> Result<Value> {
    let query = p["query"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .context("websearch requires a non-empty query")?;
    let key = std::env::var("SERPER_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            crate::auth::AuthStorage::create(&g.runtime.session.agent_dir).get_api_key("serper")
        });
    let Some(key) = key else {
        return Ok(
            json!({"result":"Web search requires a Serper API key. Use /login or set SERPER_API_KEY."}),
        );
    };
    let option = |key: &str, env: &str, default: u64| {
        p[key]
            .as_u64()
            .filter(|n| *n > 0)
            .or_else(|| std::env::var(env).ok()?.parse().ok())
            .unwrap_or(default)
    };
    let timeout = option("timeout", "WASMEDGE_AGENT_WEBSEARCH_TIMEOUT", 45);
    let n = option("num_results", "WASMEDGE_AGENT_WEBSEARCH_NUM_RESULTS", 5);
    let client = pa_ai::utils::tls::http_client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(timeout))
        .build()?;
    let v: Value = client
        .post("https://google.serper.dev/search")
        .header("X-API-KEY", key.trim())
        .json(&json!({"q":query}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let mut sections = Vec::new();
    if let Some(kg) = v["knowledgeGraph"].as_object() {
        let mut lines = Vec::new();
        if let Some(s) = kg.get("title").and_then(Value::as_str) {
            lines.push(format!("Knowledge Graph: {s}"));
        }
        if let Some(s) = kg.get("description").and_then(Value::as_str) {
            lines.push(s.into());
        }
        if let Some(m) = kg.get("attributes").and_then(Value::as_object) {
            for (k, v) in m {
                lines.push(format!("{k}: {}", v.as_str().unwrap_or("")));
            }
        }
        if !lines.is_empty() {
            sections.push(lines.join("\n"));
        }
    }
    for (i, e) in v["organic"]
        .as_array()
        .into_iter()
        .flatten()
        .take(n as usize)
        .enumerate()
    {
        let mut line = format!("Result {i}: {}", e["title"].as_str().unwrap_or("Untitled"));
        if let Some(url) = e["link"].as_str() {
            line.push_str(&format!("\nURL: {url}"));
        }
        if let Some(s) = e["snippet"].as_str() {
            line.push_str(&format!("\n{s}"));
        }
        sections.push(line);
    }
    let questions = v["peopleAlsoAsk"]
        .as_array()
        .into_iter()
        .flatten()
        .take(3)
        .filter_map(|e| {
            Some(format!(
                "Q: {}\nA: {}",
                e["question"].as_str()?,
                e["snippet"].as_str().unwrap_or("")
            ))
        })
        .collect::<Vec<_>>();
    if !questions.is_empty() {
        sections.push(format!("People Also Ask:\n{}", questions.join("\n")));
    }
    if sections.is_empty() {
        sections.push(format!("No results returned for query: {query}"));
    }
    let result = format!(
        "Results for query \"{query}\":\n\n{}",
        sections.join("\n\n---\n\n")
    );
    let limit = p["max_output"].as_u64().unwrap_or(8192) as usize;
    let chars: Vec<_> = result.chars().collect();
    if chars.len() <= limit {
        return Ok(json!({"result":result}));
    }
    let marker = format!(
        "\n... [output truncated, {} chars total] ...\n",
        chars.len()
    );
    let half = limit.saturating_sub(marker.len()) / 2;
    Ok(
        json!({"result":chars[..half].iter().copied().chain(marker.chars()).chain(chars[chars.len()-half..].iter().copied()).take(limit).collect::<String>()}),
    )
}
pub(super) async fn dispatch(
    g: &Guest<'_>,
    method: &str,
    mut payload: Value,
    source: &str,
) -> Result<Value> {
    match method {
        // Transport headers and OAuth tokens belong to the host-side MCP client.
        "mcp.config" => anyhow::bail!("MCP transport configuration is private to the host"),
        "skills.package" => package(g, &payload),
        "harness.skill.test" => {
            skills::test_reference(g, &payload["reference"]).await?;
            Ok(json!({"passed":true}))
        }
        "harness.request" => super::harness::request(g, &payload).await,
        "websearch.run" => search(g, &payload).await,
        "deps.add" => super::dependencies::add(g, &payload).await,
        "api.describe" => super::introspection::query(g, &payload).await,
        _ => {
            let handler = g.runtime.registry.get(method).with_context(|| {
                format!("host request {method} is not available in this session")
            })?;
            if !payload.is_object() {
                payload = json!({});
            }
            payload["type"] = json!(method);
            payload["cellSourceCode"] = json!(source);
            PARENT_CELL
                .scope(
                    g.runtime.session.clone(),
                    handler(HostRequestPayload { data: payload }),
                )
                .await
        }
    }
}
