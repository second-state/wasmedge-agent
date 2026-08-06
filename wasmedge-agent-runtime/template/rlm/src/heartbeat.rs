//! Recurring self-scheduled prompts for this session (DESIGN.md §2.6).
//! Payload shapes mirror the kernel-era rlm-heartbeat skill.

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::bridge;

#[derive(Debug, Clone, Default)]
pub struct HeartbeatOpts {
    /// Interval expression, e.g. "5m", "1h".
    pub interval: Option<String>,
    pub label: Option<String>,
    /// "steer" (interrupt the current turn) or "follow_up" (wait for it).
    pub delivery_mode: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct HeartbeatUpdate {
    pub instruction: Option<String>,
    pub interval: Option<String>,
    pub label: Option<String>,
    /// "active" or "paused".
    pub status: Option<String>,
    pub delivery_mode: Option<String>,
}

fn insert_some(payload: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        payload.insert(key.to_string(), Value::String(value));
    }
}

/// List heartbeats for this session.
pub fn list(include_inactive: bool) -> Result<Value> {
    bridge::request("rlm_heartbeat.list", json!({"include_inactive": include_inactive}))
}

/// Create a heartbeat that re-prompts this agent with `instruction`.
pub fn create(instruction: &str, opts: HeartbeatOpts) -> Result<Value> {
    let mut payload = Map::new();
    payload.insert("instruction".to_string(), Value::String(instruction.to_string()));
    insert_some(&mut payload, "interval", opts.interval);
    insert_some(&mut payload, "label", opts.label);
    insert_some(&mut payload, "delivery_mode", opts.delivery_mode);
    bridge::request("rlm_heartbeat.create", Value::Object(payload))
}

/// Update fields of an existing heartbeat.
pub fn update(id: &str, update: HeartbeatUpdate) -> Result<Value> {
    let mut payload = Map::new();
    payload.insert("id".to_string(), Value::String(id.to_string()));
    insert_some(&mut payload, "instruction", update.instruction);
    insert_some(&mut payload, "interval", update.interval);
    insert_some(&mut payload, "label", update.label);
    insert_some(&mut payload, "status", update.status);
    insert_some(&mut payload, "delivery_mode", update.delivery_mode);
    bridge::request("rlm_heartbeat.update", Value::Object(payload))
}

/// Delete a heartbeat by id.
pub fn delete(id: &str) -> Result<Value> {
    bridge::request("rlm_heartbeat.delete", json!({"id": id}))
}
