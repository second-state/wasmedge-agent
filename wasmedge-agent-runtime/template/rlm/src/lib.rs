//! Guest-side runtime for wasmedge-agent cells (DESIGN.md §2.6).
//!
//! Persistence: `state` (key-value + blobs on /agent/state). Host bridge:
//! `spawn`/`msg`/`goal`/`compact`/`refine`/`heartbeat`/`observe`/`mcp` plus the
//! generic `host_request` gate, all synchronous over the per-cell bridge
//! connection (§2.7). Rich output: `display`. `deps::add` is locked in
//! Phase 1 (D15).

mod bridge;
pub mod compact;
pub mod deps;
pub mod display;
pub mod error;
pub mod goal;
pub mod harness;
pub mod heartbeat;
pub mod mcp;
pub mod msg;
pub mod observe;
pub mod prelude;
pub mod refine;
mod spawn;
pub mod state;

pub use anyhow::{anyhow, bail, Context, Error as AnyError, Result};
pub use error::{Error, ErrorKind};
pub use spawn::{
    delete_subagent, find_models, list_subagents, spawn, spawn_named, spawn_with, Model, SpawnHandle, SpawnOpts,
    Subagent,
};

use serde_json::Value;

/// Generic host-request gate: send a typed request and get the reply payload.
/// The typed modules cover the common types; this is the escape hatch for new
/// host handlers (e.g. `host_request("websearch.run", json!({"query": q}))`).
pub fn host_request(request_type: &str, payload: Value) -> Result<Value> {
    anyhow::ensure!(!request_type.is_empty(), "request_type must be a non-empty str");
    bridge::request(request_type, payload)
}

/// Whether this cell has a live host bridge (false in standalone runs).
pub fn bridge_available() -> bool {
    bridge::available()
}

/// Native-target test hooks; not part of the cell-facing API.
#[cfg(not(target_os = "wasi"))]
#[doc(hidden)]
pub mod test_support {
    pub fn reset_connection() {
        crate::bridge::reset_for_tests();
    }
}
