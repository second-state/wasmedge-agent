//! Session goal contract (DESIGN.md §2.6). Payload shapes mirror the
//! kernel-era goal skill so the host handlers are reused unchanged.

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::bridge;

#[derive(Debug, Clone, Default)]
pub struct GoalOpts {
    pub token_budget: Option<u64>,
}

/// Current goal state for this session.
pub fn get() -> Result<Value> {
    bridge::request("goal.get", json!({}))
}

/// Create the session goal.
pub fn create(objective: &str, opts: GoalOpts) -> Result<Value> {
    let mut payload = Map::new();
    payload.insert("objective".to_string(), Value::String(objective.to_string()));
    if let Some(budget) = opts.token_budget {
        payload.insert("token_budget".to_string(), Value::from(budget));
    }
    bridge::request("goal.create", Value::Object(payload))
}

/// Mark the session goal complete.
pub fn complete() -> Result<Value> {
    bridge::request("goal.complete", json!({}))
}
