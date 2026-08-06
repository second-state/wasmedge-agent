//! Rich output (DESIGN.md §2.9): diff cards and image attachments surface in
//! the host UI via bridge `emit` events. Without a bridge (standalone runs,
//! bench fixtures) a readable form goes to stdout so the effect stays visible.

use std::path::Path;

use anyhow::{Context, Result};
use base64::Engine as _;
use serde_json::json;

use crate::bridge;
use crate::error::Error;

/// Soft cap for attachment payloads (base64 chars), DESIGN.md §2.9. The
/// thumbnailing port (WP6) will shrink larger images guest-side.
const MAX_ATTACHMENT_BASE64_CHARS: usize = 350_000;

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
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    if data.len() > MAX_ATTACHMENT_BASE64_CHARS {
        return Err(Error::new(
            crate::error::ErrorKind::Io,
            format!(
                "attachment {} is {} base64 chars (limit {MAX_ATTACHMENT_BASE64_CHARS}); \
                 downscale the image first",
                path.display(),
                data.len()
            ),
        )
        .into());
    }
    bridge::emit(
        "display.attachment",
        json!({"mimeType": mime, "data": data, "path": path.to_string_lossy()}),
    )
}
