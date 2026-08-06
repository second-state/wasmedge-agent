//! Rich output (DESIGN.md §2.9): diff cards and image attachments surface in
//! the host UI via bridge `emit` events. Without a bridge (standalone runs,
//! bench fixtures) a readable form goes to stdout so the effect stays visible.

use std::path::Path;

use anyhow::{Context, Result};
use base64::Engine as _;
use serde_json::json;

use crate::bridge;
use crate::error::Error;

/// Source-image cap (raw bytes). The host thumbnails oversized images down to
/// the context budget (≤1200px / ≤350K base64, DESIGN.md §2.9); this cap only
/// bounds what travels over the bridge.
const MAX_SOURCE_IMAGE_BYTES: usize = 20_000_000;

/// Show a change made to a file as a diff card.
pub fn diff(path: &str, old: &str, new: &str) -> Result<()> {
    if bridge::available() {
        return bridge::emit("display.diff", json!({"path": path, "oldStr": old, "newStr": new}));
    }
    println!("--- {path}");
    println!("+++ {path}");
    for line in old.lines() {
        println!("-{line}");
    }
    for line in new.lines() {
        println!("+{line}");
    }
    Ok(())
}

fn mime_for(path: &Path) -> Result<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        "svg" => Ok("image/svg+xml"),
        other => Err(Error::new(
            crate::error::ErrorKind::Io,
            format!("unsupported attachment extension {other:?} (png/jpg/gif/webp/svg)"),
        )
        .into()),
    }
}

/// Attach an image file to the cell output.
pub fn attach_image(path: impl AsRef<Path>) -> Result<()> {
    let path = path.as_ref();
    let mime = mime_for(path)?;
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if !bridge::available() {
        println!("[attachment: {} ({} bytes, {mime})]", path.display(), bytes.len());
        return Ok(());
    }
    if bytes.len() > MAX_SOURCE_IMAGE_BYTES {
        return Err(Error::new(
            crate::error::ErrorKind::Io,
            format!(
                "attachment {} is {} bytes (limit {MAX_SOURCE_IMAGE_BYTES}); resize it first",
                path.display(),
                bytes.len()
            ),
        )
        .into());
    }
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    bridge::emit(
        "display.attachment",
        json!({"mimeType": mime, "data": data, "path": path.to_string_lossy()}),
    )
}
