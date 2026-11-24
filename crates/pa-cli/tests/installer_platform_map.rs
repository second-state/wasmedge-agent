//! Exercise the platform detector used by the shipped installer.
#![cfg(unix)]
use std::{path::Path, process::Command};
#[test]
fn installer_selects_each_published_platform() {
    let installer =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../install.sh"))
            .unwrap();
    let functions = installer
        .strip_suffix("main \"$@\"\n")
        .expect("installer entry point");
    let script=format!("{functions}\nuname() {{ case \"$1\" in -s) echo \"$OS\";; -m) echo \"$ARCH\";; esac; }}\nnative_platform\n");
    for (os, arch, expected) in [
        ("Linux", "x86_64", "linux-x64"),
        ("Linux", "aarch64", "linux-arm64"),
        ("Darwin", "x86_64", "darwin-x64"),
        ("Darwin", "arm64", "darwin-arm64"),
        ("MINGW64_NT", "x86_64", "win32-x64"),
        ("MSYS_NT", "x86_64", "win32-x64"),
        ("CYGWIN_NT", "x86_64", "win32-x64"),
        ("Linux", "i686", ""),
    ] {
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .env("OS", os)
            .env("ARCH", arch)
            .output()
            .unwrap();
        assert_eq!(out.status.success(), !expected.is_empty(), "{os}:{arch}");
        assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), expected);
    }
}
