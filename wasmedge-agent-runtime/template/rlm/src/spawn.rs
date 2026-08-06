//! Recursive subagents (DESIGN.md §2.6): spawn is admission-only — it returns
//! as soon as the host admits the child's task, not when the child finishes.
//! Children report back via agent messages (`rlm::msg`).

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::bridge;

/// Receipt for an admitted child. Field names mirror the host payload.
#[derive(Debug, Clone, Deserialize)]
pub struct SpawnHandle {
    pub rlm_child_id: String,
    pub name: String,
    pub session_dir: String,
    pub model: String,
}

#[derive(Debug, Clone, Default)]
pub struct SpawnOpts {
    /// Stable name for addressing the child (`rlm::msg::send_to_child`).
    pub name: Option<String>,
    /// Exact `provider/model` selector (see `rlm::find_models`).
    pub model: Option<String>,
}

/// A model available for child agents.
#[derive(Debug, Clone, Deserialize)]
pub struct Model {
    pub provider: String,
    pub id: String,
    pub name: String,
    /// Pass this as `SpawnOpts.model`.
    pub selector: String,
}

/// A direct child retained by the current session.
#[derive(Debug, Clone, Deserialize)]
pub struct Subagent {
    pub rlm_child_id: String,
    #[serde(default)]
    pub active_session_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub session_name: String,
    pub session_dir: String,
    /// "running" | "completed" | "error"
    pub status: String,
}

/// Spawn a recursive child agent working on `prompt`.
pub fn spawn(prompt: &str) -> Result<SpawnHandle> {
    spawn_with(prompt, SpawnOpts::default())
}

/// Spawn a named child so it can be messaged back directly.
pub fn spawn_named(prompt: &str, name: &str) -> Result<SpawnHandle> {
    spawn_with(
        prompt,
        SpawnOpts {
            name: Some(name.to_string()),
            ..SpawnOpts::default()
        },
    )
}

/// Spawn with full options.
pub fn spawn_with(prompt: &str, opts: SpawnOpts) -> Result<SpawnHandle> {
    let mut kwargs = Map::new();
    if let Some(name) = opts.name {
        kwargs.insert("name".to_string(), Value::String(name));
    }
    if let Some(model) = opts.model {
        kwargs.insert("model".to_string(), Value::String(model));
    }
    let payload = bridge::request("rlm.run", json!({"prompt": prompt, "kwargs": Value::Object(kwargs)}))?;
    serde_json::from_value(payload).context("rlm.run returned an invalid spawn handle")
}

/// Search the bounded list of models usable for child agents.
pub fn find_models(query: &str, limit: usize) -> Result<Vec<Model>> {
    let payload = bridge::request("rlm.find_models", json!({"query": query, "limit": limit}))?;
    let models = payload
        .get("models")
        .cloned()
        .context("rlm.find_models returned no models list")?;
    serde_json::from_value(models).context("rlm.find_models returned an invalid models list")
}

/// List direct children retained by the current session.
pub fn list_subagents() -> Result<Vec<Subagent>> {
    let payload = bridge::request("rlm.list_subagents", json!({}))?;
    let entries = payload
        .get("subagents")
        .cloned()
        .context("rlm.list_subagents returned no subagents registry")?;
    serde_json::from_value(entries).context("rlm.list_subagents returned an invalid subagents registry")
}

/// Delete one running or retained direct child. `target` is a child id or name.
pub fn delete_subagent(target: &str) -> Result<Subagent> {
    let target = target.trim();
    anyhow::ensure!(!target.is_empty(), "target must not be empty");
    let payload = bridge::request("rlm.delete_subagent", json!({"target": target}))?;
    let entry = payload
        .get("subagent")
        .cloned()
        .context("rlm.delete_subagent returned no subagent entry")?;
    serde_json::from_value(entry).context("rlm.delete_subagent returned an invalid subagent entry")
}
