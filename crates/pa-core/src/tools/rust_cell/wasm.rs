use super::{config, process, sandbox};
use anyhow::{bail, ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use wasmparser::{Encoding, Parser, Payload, TypeRef, Validator};

fn allowed(name: &str) -> bool {
    matches!(
        name,
        "args_get"
            | "args_sizes_get"
            | "environ_get"
            | "environ_sizes_get"
            | "clock_res_get"
            | "clock_time_get"
            | "fd_advise"
            | "fd_allocate"
            | "fd_close"
            | "fd_datasync"
            | "fd_fdstat_get"
            | "fd_fdstat_set_flags"
            | "fd_fdstat_set_rights"
            | "fd_filestat_get"
            | "fd_filestat_set_size"
            | "fd_filestat_set_times"
            | "fd_pread"
            | "fd_prestat_get"
            | "fd_prestat_dir_name"
            | "fd_pwrite"
            | "fd_read"
            | "fd_readdir"
            | "fd_renumber"
            | "fd_seek"
            | "fd_sync"
            | "fd_tell"
            | "fd_write"
            | "path_create_directory"
            | "path_filestat_get"
            | "path_filestat_set_times"
            | "path_link"
            | "path_open"
            | "path_readlink"
            | "path_remove_directory"
            | "path_rename"
            | "path_symlink"
            | "path_unlink_file"
            | "poll_oneoff"
            | "proc_exit"
            | "proc_raise"
            | "random_get"
            | "sched_yield"
    )
}
fn inspected(bytes: &[u8]) -> Result<(Vec<u8>, bool)> {
    Validator::new()
        .validate_all(bytes)
        .context("cannot validate Wasm module")?;
    let mut clean = Vec::new();
    let mut native = false;
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload?;
        match &payload {
            Payload::Version {
                encoding: Encoding::Module,
                ..
            } => clean.extend_from_slice(b"\0asm\x01\0\0\0"),
            Payload::Version { .. } => bail!("expected a core WASI module"),
            Payload::ImportSection(entries) => {
                for entry in entries.clone().into_imports() {
                    let entry = entry?;
                    ensure!(
                        entry.module == "wasi_snapshot_preview1"
                            && matches!(entry.ty, TypeRef::Func(_))
                            && allowed(entry.name),
                        "cell import not allowed: {}.{}",
                        entry.module,
                        entry.name
                    );
                }
            }
            Payload::CustomSection(c) => {
                native |= c.name() == "wasmedge" && !c.data().is_empty();
                continue;
            }
            _ => {}
        }
        if let Some((id, range)) = payload.as_section() {
            let start = usize::try_from(range.start)?;
            let end = usize::try_from(range.end)?;
            let section = bytes
                .get(start..end)
                .context("invalid Wasm section range")?;
            clean.push(id);
            let mut n = section.len();
            loop {
                let low = (n & 127) as u8;
                n >>= 7;
                clean.push(if n == 0 { low } else { low | 128 });
                if n == 0 {
                    break;
                }
            }
            clean.extend_from_slice(section);
        }
    }
    Ok((clean, native))
}
/// Use a host-owned copy of the exact inspected bytes. Neither a mutable Cargo
/// output nor a guest-provided native custom section is ever executed.
pub(super) async fn prepare(
    source: &Path,
    directory: &Path,
    cfg: &config::Config,
    group: &sandbox::Resources,
    aot: bool,
) -> Result<PathBuf> {
    let bytes = tokio::fs::read(source).await?;
    let (clean, _) = inspected(&bytes)?;
    let file = directory.join("input.wasm");
    tokio::fs::write(&file, &clean).await?;
    if !aot {
        return Ok(file);
    }
    let compiler = std::env::var_os("WASMEDGE_AGENT_AOT_COMPILER")
        .map(PathBuf::from)
        .unwrap_or_else(|| config::program("wasmedge", "WASMEDGE_AGENT_WASMEDGE"));
    let artifact = directory.join("cell.aot.wasm");
    let mut cmd = process::command(&compiler, directory);
    cmd.args(["compile", "--interruptible"]);
    if cfg.cell_gas_limit.is_some() {
        cmd.arg("--enable-gas-measuring");
    }
    cmd.arg(&file).arg(&artifact);
    process::run(group.wrap(cmd)?, None)
        .await?
        .require("WasmEdge AOT compilation")?;
    let output = tokio::fs::read(&artifact).await?;
    let (compiled, native) = inspected(&output)?;
    ensure!(
        native && clean == compiled,
        "AOT compiler did not preserve the inspected Wasm or emit a native payload"
    );
    let digest = |data: &[u8]| hex::encode(Sha256::digest(data));
    tokio::fs::write(directory.join("provenance.json"),serde_json::to_vec(&serde_json::json!({"version":1,"sourceSha256":digest(&bytes),"inspectedSha256":digest(&clean),"artifactSha256":digest(&output),"compiler":compiler}))?).await?;
    Ok(artifact)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_undeclared_imports_and_strips_custom_sections() {
        let core = b"\0asm\x01\0\0\0";
        let mut module = core.to_vec();
        module.extend_from_slice(b"\0\x04\x01x12");
        assert_eq!(inspected(&module).unwrap().0, core);
        assert!(!allowed("sock_open"));
        assert!(allowed("fd_write"));
        assert!(inspected(b"invalid").is_err());
    }

    #[test]
    fn preserves_sections_with_multibyte_lengths() {
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        // A type section containing 43 empty function signatures occupies 130 bytes.
        module.extend_from_slice(&[1, 0x82, 0x01, 43]);
        for _ in 0..43 {
            module.extend_from_slice(&[0x60, 0, 0]);
        }
        let mut with_custom = module.clone();
        with_custom.extend_from_slice(b"\0\x04\x01x12");
        assert_eq!(inspected(&with_custom).unwrap().0, module);
    }
}
