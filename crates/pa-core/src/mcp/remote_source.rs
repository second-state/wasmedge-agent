//! The WasmEdge distribution ships the MCP catalog as a package asset.
use super::catalog_schema::{parse_plugins_catalog, PluginsCatalog};
use std::path::Path;

pub fn remote_plugins_snapshot(_agent_dir: &Path) -> Option<PluginsCatalog> {
    bundled_plugins_snapshot()
}

pub fn bundled_plugins_snapshot() -> Option<PluginsCatalog> {
    let assets = pa_models::bundled::BundledAssets::at_package_root();
    let raw = assets.read_mcp_services()?;
    parse_plugins_catalog(raw.as_bytes()).ok()
}
