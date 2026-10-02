//! Host-managed additions from the curated WASI-compatible crate catalog.

use anyhow::Result;
use serde_json::json;
use std::time::Duration;

use crate::bridge;

/// Make a curated crate available under `agent_lib::prelude::extra` in the
/// next cell. This cell is already compiled. Names use their crates.io spelling;
/// Rust paths replace hyphens with underscores. Repeated additions are harmless.
pub fn add(crate_name: &str) -> Result<()> {
    // Dependency preflight can compile the library; use the cell budget rather
    // than the ordinary short bridge deadline. The host enforces total time.
    let timeout = std::env::var("RLM_CELL_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(30));
    bridge::request_with_timeout("deps.add", json!({"crate_name": crate_name}), timeout)?;
    Ok(())
}
