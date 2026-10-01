//! Continual-harness CRUD through the authenticated host bridge.
//! The host owns persistence and tests skill mutations before saving them.
//! Harness stores are not exposed as guest filesystem mounts.

use anyhow::Result;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;
use serde_json::{json, Value};

use crate::error::{Error, ErrorKind};

pub const KINDS: [&str; 4] = ["prompt", "memory", "skill", "subagent"];

fn state_err(message: impl Into<String>) -> anyhow::Error {
    Error::new(ErrorKind::State, message.into()).into()
}

/// One reusable prompt note, memory, skill, or subagent record. Field names
/// match the host `harness_state.json` schema exactly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    #[serde(default = "default_path")]
    pub path: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default = "empty_object")]
    pub reference: Value,
    #[serde(default = "empty_object")]
    pub arguments: Value,
    #[serde(default = "empty_object")]
    pub metadata: Value,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default = "default_version")]
    pub version: u64,
}

/// A recorded refinement pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefinementEvent {
    pub id: String,
    pub trigger: String,
    #[serde(default)]
    pub changes: Vec<String>,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub created_at: String,
}

fn default_path() -> String {
    "general".to_string()
}
fn default_scope() -> String {
    "local".to_string()
}
fn default_source() -> String {
    "agent".to_string()
}
fn default_version() -> u64 {
    1
}
fn empty_object() -> Value {
    json!({})
}

/// Skill entries must carry a rust reference (DESIGN.md §4.3): the mounted
/// crate path plus how to call it. Kernel-era python references stay readable
/// but cannot be created. Kept in sync with the host validator in
/// `refinement.ts`.
pub fn validate_rust_skill_reference(reference: &Value) -> Result<()> {
    let obj = reference
        .as_object()
        .ok_or_else(|| state_err("skill entries require a rust reference object"))?;
    match obj.get("type").and_then(Value::as_str) {
        Some("rust") => {}
        Some("python") => {
            return Err(state_err(
                "python skill references are legacy (read-only); create rust skills with type \"rust\"",
            ))
        }
        _ => return Err(state_err("skill reference.type must be \"rust\"")),
    }
    let has_use = obj.get("use").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if !has_use {
        return Err(state_err(
            "skill reference requires \"use\" (e.g. \"agent_lib::skills::my_skill\")",
        ));
    }
    let has_call = ["callable", "call_pattern"]
        .iter()
        .any(|key| obj.get(*key).and_then(Value::as_str).is_some_and(|s| !s.is_empty()));
    if !has_call {
        return Err(state_err("skill reference requires a callable or call_pattern"));
    }
    Ok(())
}

/// Handle on one host-owned harness store (local or global).
pub struct Harness {
    scope: &'static str,
}

/// The session-local harness store. Requires a live host bridge.
pub fn local() -> Result<Harness> {
    Harness::open("local")
}

/// The cross-session global harness store. Requires a live host bridge.
pub fn global() -> Result<Harness> {
    Harness::open("global")
}

impl Harness {
    fn open(scope: &'static str) -> Result<Self> {
        let harness = Self { scope };
        if !harness.request::<bool>("open", json!({}))? {
            return Err(state_err(format!("{scope} harness state is unavailable")));
        }
        Ok(harness)
    }

    fn request<T: DeserializeOwned>(&self, operation: &str, mut payload: Value) -> Result<T> {
        let skill_mutation = payload["kind"] == "skill" && matches!(operation, "create" | "update");
        payload["operation"] = json!(operation);
        payload["scope"] = json!(self.scope);
        let timeout = if skill_mutation {
            std::env::var("RLM_CELL_TIMEOUT_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|millis| *millis > 0)
                .map(Duration::from_millis)
                .unwrap_or(Duration::from_secs(30))
        } else {
            Duration::from_secs(30)
        };
        let mut reply = crate::bridge::request_with_timeout("harness.request", payload, timeout)?;
        let value = reply.as_object_mut().and_then(|object| object.remove("value"))
            .ok_or_else(|| state_err("host harness reply is missing value"))?;
        serde_json::from_value(value).map_err(|error| state_err(format!("invalid host harness reply: {error}")))
    }

    /// Fetch one entry. Scope-prefixed ids from overview() are accepted.
    pub fn get(&mut self, kind: &str, id: &str) -> Result<Option<Entry>> {
        self.request("get", json!({"kind": kind, "id": id}))
    }

    /// List entries, optionally filtered by kind.
    pub fn list(&mut self, kind: Option<&str>) -> Result<Vec<Entry>> {
        self.request("list", json!({"kind": kind}))
    }

    /// Delete one entry. Returns whether it existed.
    pub fn delete(&mut self, kind: &str, id: &str) -> Result<bool> {
        self.request("delete", json!({"kind": kind, "id": id}))
    }

    fn create(&self, kind: &str, title: &str, content: &str) -> Result<Entry> {
        self.request("create", json!({"kind": kind, "title": title, "content": content}))
    }

    /// Create a memory entry (durable facts, decisions, preferences).
    pub fn create_memory(&mut self, title: &str, content: &str) -> Result<Entry> {
        self.create("memory", title, content)
    }

    /// Create a prompt-note entry (narrow behavioral policy addendums).
    pub fn create_prompt_note(&mut self, title: &str, content: &str) -> Result<Entry> {
        self.create("prompt", title, content)
    }

    /// Create a subagent spec entry (reusable delegation roles).
    pub fn create_subagent(&mut self, title: &str, content: &str) -> Result<Entry> {
        self.create("subagent", title, content)
    }

    /// Create a skill after the host validates its Rust reference and runs
    /// sandboxed tests. No entry is saved on failure.
    pub fn create_skill(&mut self, title: &str, content: &str, reference: Value, arguments: Value) -> Result<Entry> {
        validate_rust_skill_reference(&reference)?;
        self.request("create", json!({
            "kind": "skill", "title": title, "content": content,
            "reference": reference, "arguments": arguments,
        }))
    }

    /// Update title/content, preserving other fields. Skill updates retest
    /// the stored reference on the host before saving.
    pub fn update(&mut self, kind: &str, id: &str, title: &str, content: &str) -> Result<Entry> {
        self.request("update", json!({"kind": kind, "id": id, "title": title, "content": content}))
    }

    /// Update a skill's reference/arguments after sandboxed tests pass.
    pub fn update_skill(&mut self, id: &str, title: &str, content: &str, reference: Value, arguments: Value) -> Result<Entry> {
        validate_rust_skill_reference(&reference)?;
        self.request("update", json!({
            "kind": "skill", "id": id, "title": title, "content": content,
            "reference": reference, "arguments": arguments,
        }))
    }

    /// Record a refinement pass (what changed and why).
    pub fn record_refinement(&mut self, trigger: &str, changes: &[&str], evidence: &str, outcome: &str) -> Result<RefinementEvent> {
        self.request("record_refinement", json!({
            "trigger": trigger, "changes": changes, "evidence": evidence, "outcome": outcome,
        }))
    }

    /// Compact human-readable listing of every entry and refinement count.
    pub fn overview(&mut self) -> Result<String> {
        self.request("overview", json!({}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_reference_validation_is_rust_only() {
        let err = validate_rust_skill_reference(&json!({"type": "python", "import": "fetcher"})).unwrap_err();
        assert!(format!("{err:#}").contains("legacy"));
        let err = validate_rust_skill_reference(&json!({"type": "rust", "use": "agent_lib::skills::fetcher"})).unwrap_err();
        assert!(format!("{err:#}").contains("callable or call_pattern"));
        validate_rust_skill_reference(&json!({
            "type": "rust", "use": "agent_lib::skills::fetcher", "call_pattern": "agent_lib::skills::fetcher::run(url)?"
        })).unwrap();
    }
}
