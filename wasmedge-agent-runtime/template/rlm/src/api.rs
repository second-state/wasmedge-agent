//! On-demand public API introspection for agent_lib, mounted skills, and rlm.
//! Requires the host's rustCell.rustdocToolchain setting. Cargo/rustdoc execute
//! on the host; this does not run the documented functions or their doctests.

use anyhow::Result;
use serde_json::{json, Value};
use std::time::Duration;

use crate::bridge;

fn request(path: &str, mode: &str, offset: usize) -> Result<Value> {
    let timeout = std::env::var("RLM_CELL_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(30));
    bridge::request_with_timeout(
        "api.describe",
        json!({"path": path, "mode": mode, "offset": offset}),
        timeout,
    )
}

/// List public paths below a module or type. Pass a returned nextOffset to
/// list_page for the next page. An unchanged source snapshot reuses its cache.
pub fn list(path: &str) -> Result<Value> {
    list_page(path, 0)
}

/// Continue a paginated list of public API paths.
pub fn list_page(path: &str, offset: usize) -> Result<Value> {
    request(path, "list", offset)
}

/// Return an item's structured rustdoc declaration, including signatures,
/// generics, docs and queryable paths for fields, variants and associated items.
/// Third-party items without local rustdoc data are labeled external_reexport.
pub fn describe(path: &str) -> Result<Value> {
    request(path, "describe", 0)
}
