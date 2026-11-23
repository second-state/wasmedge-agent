use super::{guest::Guest, skills};
use crate::refinement::{self as r, HarnessScope, RefinementKind};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
fn text<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p[key]
        .as_str()
        .with_context(|| format!("harness request requires {key} as a string"))
}
fn store(g: &Guest<'_>, scope: HarnessScope) -> Result<PathBuf> {
    let s = &g.runtime.session;
    match scope {
        HarnessScope::Local => {
            r::get_local_harness_state_dir(s.persistent.then_some(&s.artifact_dir))
                .context("local harness unavailable")
        }
        HarnessScope::Global => Ok(r::get_global_harness_state_dir(&s.agent_dir)),
    }
}
pub(super) async fn revalidate(g: &Guest<'_>) -> Result<()> {
    let mut tested = std::collections::BTreeSet::new();
    for scope in [HarnessScope::Global, HarnessScope::Local] {
        if let Ok(dir) = store(g, scope) {
            let state = r::load_harness_state(&dir, scope);
            for e in state
                .entries
                .get(&RefinementKind::Skill)
                .into_iter()
                .flat_map(|m| m.values())
            {
                let v = Value::Object(e.reference.clone());
                if v["type"] == "rust" {
                    let name = v["use"]
                        .as_str()
                        .and_then(|s| s.strip_prefix("agent_lib::skills::"))
                        .and_then(|s| s.split("::").next())
                        .context("invalid stored Rust skill reference")?;
                    if skills::identifier(name)
                        && g.ws.join("skills").join(name).is_dir()
                        && tested.insert(name.to_owned())
                    {
                        skills::test_reference(g, &v).await?;
                    }
                }
            }
        }
    }
    Ok(())
}
pub(super) async fn request(g: &Guest<'_>, p: &Value) -> Result<Value> {
    let scope: HarnessScope = serde_json::from_value(p["scope"].clone())?;
    let dir = store(g, scope)?;
    let op = text(p, "operation")?;
    if op == "open" {
        return Ok(json!({"value":true}));
    }
    let state = r::load_harness_state(&dir, scope);
    let now = crate::session::manager::format_iso_now();
    if op == "list" || op == "overview" {
        let mut entries = Vec::new();
        let mut overview = Vec::new();
        for k in ["prompt", "memory", "skill", "subagent"] {
            if op == "list" && !p["kind"].is_null() && p["kind"] != k {
                continue;
            }
            let kind: RefinementKind = serde_json::from_value(json!(k))?;
            let available = &state.entries[&kind];
            overview.push(format!("{k} ({}):", available.len()));
            for e in available.values() {
                entries.push(e);
                overview.push(format!(
                    "- [{}:{}] {} ({}, v{}): {}",
                    p["scope"].as_str().unwrap_or_default(),
                    e.id,
                    e.title,
                    e.path,
                    e.version,
                    e.content
                        .replace('\n', " ")
                        .chars()
                        .take(120)
                        .collect::<String>()
                ));
            }
        }
        overview.push(format!("refinements: {}", state.refinements.len()));
        return Ok(json!({"value":if op=="list"{json!(entries)}else{json!(overview.join("\n"))}}));
    }
    if op == "record_refinement" {
        let mut event = r::HarnessRefinementEvent {
            id: String::new(),
            changes: serde_json::from_value(p["changes"].clone())?,
            trigger: text(p, "trigger")?.into(),
            evidence: text(p, "evidence")?.into(),
            outcome: text(p, "outcome")?.into(),
            created_at: now,
        };
        let (v, _) = r::update_harness_state(&dir, scope, |live| {
            event.id = format!("refine_{:04}", live.refinements.len() + 1);
            live.refinements.push(event.clone());
            json!(event)
        })?;
        return Ok(json!({"value":v}));
    }
    let k = text(p, "kind")?;
    ensure!(
        ["prompt", "memory", "skill", "subagent"].contains(&k),
        "unknown harness kind {k}"
    );
    let kind: RefinementKind = serde_json::from_value(json!(k))?;
    let id = if op == "create" {
        let title = text(p, "title")?.to_ascii_lowercase();
        let slug = regex::Regex::new("[^a-z0-9]+")
            .unwrap()
            .replace_all(title.trim(), "_");
        let slug = slug.trim_matches('_');
        if slug.is_empty() {
            k.to_owned()
        } else {
            slug.chars().take(80).collect()
        }
    } else {
        let id = text(p, "id")?;
        if let Some((s, id)) = id
            .split_once(':')
            .filter(|(s, _)| *s == "local" || *s == "global")
        {
            ensure!(p["scope"] == s, "entry belongs to the {s} store");
            id.to_owned()
        } else {
            id.to_owned()
        }
    };
    let before = state.entries[&kind].get(&id);
    if op == "get" {
        return Ok(json!({"value":before}));
    }
    ensure!(
        !(kind == RefinementKind::Prompt && id == "base_system_prompt"),
        "base system prompt is not editable"
    );
    if op == "delete" {
        return Ok(
            json!({"value":r::update_harness_state(&dir,scope,|s|s.entries.get_mut(&kind).unwrap().remove(&id).is_some())?.0}),
        );
    }
    match op {
        "create" => ensure!(before.is_none(), "entry {id} already exists"),
        "update" => ensure!(before.is_some(), "entry {id} does not exist"),
        _ => bail!("unknown harness operation {op}"),
    }
    let mut after = before.cloned().unwrap_or_else(|| r::HarnessEntry {
        id: id.clone(),
        kind,
        scope: Some(scope),
        title: String::new(),
        content: String::new(),
        path: "general".into(),
        metadata: Default::default(),
        source: "agent".into(),
        created_at: now.clone(),
        updated_at: now.clone(),
        version: 0,
        reference: Default::default(),
        arguments: Default::default(),
    });
    after.title = text(p, "title")?.into();
    after.content = text(p, "content")?.into();
    after.updated_at = now;
    after.version += 1;
    if kind == RefinementKind::Skill {
        if let Some(v) = p.get("reference") {
            after.reference = v.as_object().context("expected a Rust reference")?.clone();
        }
        if let Some(v) = p.get("arguments") {
            after.arguments = v.as_object().context("expected skill arguments")?.clone();
        } else {
            ensure!(op != "create", "skill requires arguments");
        }
        let reference = Value::Object(after.reference.clone());
        ensure!(
            ["callable", "call_pattern"]
                .iter()
                .any(|k| reference[k].as_str().is_some_and(|s| !s.trim().is_empty())),
            "skill requires callable or call_pattern"
        );
        skills::test_reference(g, &reference).await?;
    }
    let value = json!(after);
    r::try_update_harness_state(&dir, scope, |live| {
        let map = live
            .entries
            .get_mut(&kind)
            .context("invalid harness kind")?;
        ensure!(map.get(&id) == before, "entry {id} changed during update");
        map.insert(id, after);
        Ok(())
    })?;
    Ok(json!({"value":value}))
}
