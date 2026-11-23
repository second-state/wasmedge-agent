//! Verify that the Rust packager emits archives the CLI's update reader accepts.
use pa_core::update::release::parse_channel_manifest;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path, process::Command};

#[test]
fn packaged_releases_match_the_channel_reader() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let hosts = tmp.path().join("hosts");
    let platforms = [
        "linux-x64",
        "linux-arm64",
        "darwin-x64",
        "darwin-arm64",
        "win32-x64",
    ];
    for p in platforms {
        let dir = hosts.join(p);
        fs::create_dir_all(&dir).unwrap();
        let exe = if p == "win32-x64" {
            "wasmedge-agent.exe"
        } else {
            "wasmedge-agent"
        };
        fs::write(dir.join(exe), format!("fixture for {p}")).unwrap();
    }
    for (channel, version) in [("stable", "1.2.3"), ("beta", "1.2.4-beta.7")] {
        let out = tmp.path().join(channel);
        let result = Command::new(env!("CARGO"))
            .current_dir(&root)
            .args([
                "run",
                "--release",
                "--locked",
                "-p",
                "xtask",
                "--",
                "pack",
                "--base-url",
                "https://github.com/second-state/wasmedge-agent/releases",
                "--channel",
                channel,
                "--version",
                version,
                "--hosts",
            ])
            .arg(&hosts)
            .arg("--out-dir")
            .arg(&out)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let dir = out.join("artifacts");
        let bytes = fs::read(dir.join("release.json")).unwrap();
        let release = parse_channel_manifest(&bytes).unwrap();
        assert_eq!(release.version, version);
        assert_eq!(release.artifacts.len(), platforms.len());
        let sums = fs::read_to_string(dir.join("SHA256SUMS")).unwrap();
        for artifact in release.artifacts {
            let path = dir.join(&artifact.file);
            let hash = hex::encode(Sha256::digest(fs::read(path).unwrap()));
            assert_eq!(hash, artifact.sha256);
            assert!(sums.contains(&format!("{hash}  {}", artifact.file)));
        }
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let sdk = manifest["sdk"]["file"].as_str().unwrap();
        let archive = fs::read(dir.join(sdk)).unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(&archive)),
            manifest["sdk"]["sha256"]
        );
        let mut sdk_version = None;
        for entry in tar::Archive::new(flate2::read::GzDecoder::new(&archive[..]))
            .entries()
            .unwrap()
        {
            let mut entry = entry.unwrap();
            if entry.path().unwrap()
                == Path::new(&format!("wasmedge-agent-sdk-{version}/Cargo.toml"))
            {
                let mut contents = String::new();
                entry.read_to_string(&mut contents).unwrap();
                let manifest: toml::Value = toml::from_str(&contents).unwrap();
                sdk_version = manifest["workspace"]["package"]["version"]
                    .as_str()
                    .map(str::to_owned);
                break;
            }
        }
        assert_eq!(sdk_version.as_deref(), Some(version));
        assert_eq!(
            fs::read_to_string(dir.join(channel)).unwrap().trim(),
            format!("v{version}")
        );
        assert_eq!(dir.join("latest.json").exists(), channel == "stable");
    }
}
