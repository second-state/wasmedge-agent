//! Read-only observation of agents in the current family (DESIGN.md §2.6).

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::bridge;

/// List observable agents.
pub fn list_agents() -> Result<Value> {
    bridge::request("agent_observe.list", json!({}))
}

/// Snapshot one agent's state. `target` is an agent id or name.
pub fn get_agent(target: &str) -> Result<Value> {
    bridge::request("agent_observe.get", json!({"target": target}))
}

/// Recent conversation excerpts from one agent.
pub fn recent_messages(target: &str, limit: Option<u64>, max_chars: Option<u64>) -> Result<Value> {
    let mut payload = Map::new();
    payload.insert("target".to_string(), Value::String(target.to_string()));
    if let Some(limit) = limit {
        payload.insert("limit".to_string(), Value::from(limit));
    }
    if let Some(max_chars) = max_chars {
        payload.insert("max_chars".to_string(), Value::from(max_chars));
    }
    bridge::request("agent_observe.recent", Value::Object(payload))
}
