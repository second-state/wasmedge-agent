//! The fork's native release matrix, artifact handoff and publication guards.
use serde_yaml::Value;
use std::{collections::BTreeSet, path::Path};

#[test]
fn native_hosts_are_staged_before_publishing() {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.github/workflows/build-binaries.yml");
    let text = std::fs::read_to_string(path).unwrap();
    let yaml: Value = serde_yaml::from_str(&text).unwrap();
    let jobs = &yaml["jobs"];
    let rows = jobs["native-host"]["strategy"]["matrix"]["include"]
        .as_sequence()
        .unwrap();
    let actual: BTreeSet<_> = rows
        .iter()
        .map(|row| row["platform"].as_str().unwrap())
        .collect();
    assert_eq!(
        actual,
        BTreeSet::from([
            "darwin-arm64",
            "darwin-x64",
            "linux-arm64",
            "linux-x64",
            "win32-x64"
        ])
    );
    assert!(jobs["build"]["needs"]
        .as_sequence()
        .unwrap()
        .iter()
        .any(|j| j.as_str() == Some("native-host")));
    assert!(jobs["publish"]["needs"]
        .as_sequence()
        .unwrap()
        .iter()
        .any(|j| j.as_str() == Some("build")));
    for step in [
        "cargo build --release --locked --bin wasmedge-agent",
        "cargo run --release --locked -p xtask -- pack",
        "scripts/guard-immutable-github-assets.sh",
        "scripts/publish-github-release-assets.sh",
    ] {
        assert!(text.contains(step), "missing release step {step}");
    }
    let publish = text.find("gh release upload beta").unwrap();
    let assets = &text[publish..];
    assert!(assets
        .find("beta-channel")
        .is_none_or(|_| assets.contains("install.sh")));
    assert!(assets.find("install.sh").unwrap() < assets.find("beta.json").unwrap());
}
