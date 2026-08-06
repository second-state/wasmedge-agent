//! Messages between agents in the current family (DESIGN.md §2.6). Sends go
//! through the host (`agent_message.send`); the returned receipt notes whether
//! delivery was immediate ("delivered") or queued for the receiver's next turn.
//!
//! Send messages while the cell is running — a cell's bridge connection closes
//! when the cell process exits, so there are no late sends from finished cells.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::bridge;

/// One agent in the current family roster.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// "parent" | "sibling" | "child"
    pub relationship: String,
    #[serde(default)]
    pub status: Option<String>,
}

/// Send a message to the parent agent. Returns the delivery receipt.
pub fn send_to_parent(message: &str) -> Result<Value> {
    bridge::request(
        "agent_message.send",
        json!({"message": message, "receiver_role": "parent", "receiver_name": null}),
    )
}

/// Send a message to a direct child by name (see `rlm::spawn_named`).
pub fn send_to_child(name: &str, message: &str) -> Result<Value> {
    bridge::request(
        "agent_message.send",
        json!({"message": message, "receiver_role": "child", "receiver_name": name}),
    )
}

/// Send a message to a sibling agent by name.
pub fn send_to_sibling(name: &str, message: &str) -> Result<Value> {
    bridge::request(
        "agent_message.send",
        json!({"message": message, "receiver_role": "sibling", "receiver_name": name}),
    )
}

/// Broadcast a message to every agent in the family roster.
pub fn broadcast(message: &str) -> Result<Value> {
    bridge::request("agent_message.send", json!({"target": "all", "message": message}))
}

/// List the agents reachable from this session.
pub fn list_agents() -> Result<Vec<AgentInfo>> {
    let payload = bridge::request("agent_message.list_agents", json!({}))?;
    let entries = payload
        .get("entries")
        .cloned()
        .context("agent_message.list_agents returned no roster entries")?;
    serde_json::from_value(entries).context("agent_message.list_agents returned an invalid roster")
}
