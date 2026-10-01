//! Project-local Rust skill scaffolding. Reload to mount a new crate; harness
//! registration remains a separate operation with sandboxed tests.

use anyhow::Result;
use serde::Deserialize;
use serde_json::json;

use crate::bridge;

#[derive(Debug, Deserialize)]
pub struct PackagedSkill {
    /// Absolute guest path under /workspace.
    pub path: String,
    pub crate_name: String,
    pub rust_use: String,
    pub requires_reload: bool,
}

/// Create SKILL.md, Cargo.toml and src/lib.rs without overwriting an existing
/// skill. `instructions` documents public signatures; `source` is a complete
/// Rust library, including its deterministic unit tests. This only scaffolds
/// files: it does not compile, test, mount or register the skill.
pub fn package(
    name: &str,
    description: &str,
    instructions: &str,
    source: &str,
) -> Result<PackagedSkill> {
    let reply = bridge::request(
        "skills.package",
        json!({"name": name, "description": description, "instructions": instructions, "source": source}),
    )?;
    Ok(serde_json::from_value(reply)?)
}
