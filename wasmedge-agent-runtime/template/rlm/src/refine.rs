//! Self-refinement controls (DESIGN.md §2.6): ask the host to schedule a
//! refinement pass over the current session's harness state.

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::bridge;

/// Refinement availability and scheduling state.
pub fn status() -> Result<Value> {
    bridge::request("refine.status", json!({}))
}

/// Schedule a refinement pass. `global` targets the global harness store.
/// Returns `{"scheduled": true}` or `{"scheduled": false, "reason": ...}`.
pub fn run(instructions: Option<&str>, global: bool) -> Result<Value> {
    let mut payload = Map::new();
    if let Some(instructions) = instructions {
        payload.insert("instructions".to_string(), Value::String(instructions.to_string()));
    }
    if global {
        payload.insert("global".to_string(), Value::Bool(true));
    }
    bridge::request("refine.run", Value::Object(payload))
}
