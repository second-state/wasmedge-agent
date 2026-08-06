//! Dependency management (DESIGN.md D15): the Phase 1 prelude is locked.

use anyhow::Result;

use crate::error::Error;

/// Always unsupported in Phase 1 (D15). The curated allowlist arrives in
/// Phase 2; until then structure code around the locked prelude.
pub fn add(crate_name: &str) -> Result<()> {
    Err(Error::host(format!(
        "rlm::deps::add({crate_name:?}) is not supported: the dependency set is locked in Phase 1 \
         (available: serde, serde_json, anyhow, regex, walkdir). Solve with the prelude, or tell \
         the user this task needs an extra crate."
    ))
    .into())
}
