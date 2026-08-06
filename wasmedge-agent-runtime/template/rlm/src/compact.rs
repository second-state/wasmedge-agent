//! Conversation compaction controls (DESIGN.md §2.6).

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::bridge;

/// Compaction availability and scheduling state.
pub fn status() -> Result<Value> {
    bridge::request("compact.status", json!({}))
}

/// Schedule a compaction, optionally with steering instructions. Returns
/// `{"scheduled": true}` or `{"scheduled": false, "reason": ...}`.
pub fn run(instructions: Option<&str>) -> Result<Value> {
    let mut payload = Map::new();
    if let Some(instructions) = instructions {
        payload.insert("instructions".to_string(), Value::String(instructions.to_string()));
    }
    bridge::request("compact.run", Value::Object(payload))
}
