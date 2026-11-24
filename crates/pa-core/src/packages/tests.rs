//! Package lifecycle against local resource directories and a filesystem Git remote.

use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(unix)]
use crate::packages::exe_dir_of;
use crate::packages::source::{GitSource, SourceScope, UserOrProject};
use crate::packages::PackageManager;
use crate::settings::SettingsManager;

/// A bare repo with one commit on `main`, plus a work clone for follow-up
/// commits.
fn make_bare_repo(dir: &Path) -> (PathBuf, PathBuf) {
    let bare = dir.join("bare").join("fixtures").join("repo.git");
    let work = dir.join("work");
    std::fs::create_dir_all(&bare).unwrap();
    std::fs::create_dir_all(&work).unwrap();

    let bare_str = bare.display().to_string();
    run_git(&work, &["init", "-q", "--bare", &bare_str]);
    run_git(&work, &["init", "-q"]);
    run_git(&work, &["config", "user.email", "test@example.com"]);
    run_git(&work, &["config", "user.name", "test"]);
    std::fs::write(
        work.join("package.json"),
        "intentionally invalid foreign manifest",
    )
    .unwrap();
    run_git(&work, &["add", "."]);
    run_git(&work, &["commit", "-qm", "init"]);
    run_git(&work, &["branch", "-M", "main"]);
    run_git(&work, &["remote", "add", "origin", &bare_str]);
    run_git(&work, &["push", "-q", "origin", "main"]);
    run_git(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    (bare, work)
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .expect("git is required for package tests");
    assert!(status.success(), "git {args:?} failed");
}

struct Sandbox {
    _dir: tempfile::TempDir,
    root: PathBuf,
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl Sandbox {
    fn new(_prefix: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&agent_dir).unwrap();
        let root = dir.path().to_path_buf();
        Self {
            _dir: dir,
            root,
            cwd,
            agent_dir,
        }
    }

    fn manager(&self) -> PackageManager {
        let settings = SettingsManager::create(&self.cwd, &self.agent_dir);
        PackageManager::new(&self.cwd, &self.agent_dir, settings)
    }
}

#[test]
fn legacy_registry_entries_can_be_listed_and_removed_without_installing() {
    let sandbox = Sandbox::new("legacy");
    let source = "npm:@scope/example@1.0";
    let local = sandbox.root.join("resources");
    std::fs::create_dir_all(local.join("prompts")).unwrap();
    std::fs::write(local.join("prompts/hello.md"), "Hello").unwrap();
    std::fs::write(sandbox.agent_dir.join("settings.json"),
        serde_json::json!({"packages":[{"source":source}, local], "npmCommand":["missing-command"]}).to_string()).unwrap();
    let mut manager = sandbox.manager();
    assert!(manager
        .install_and_persist(source, UserOrProject::User)
        .unwrap_err()
        .to_string()
        .contains("Use a Git URL"));
    assert!(manager.update(Some(source)).is_err());
    manager.update(None).unwrap();
    assert!(manager.list_configured_packages()[0]
        .installed_path
        .is_none());
    let resolved = manager
        .resolve_with_on_missing(Some(&mut |_| panic!("unexpected install")))
        .unwrap();
    assert!(resolved
        .prompts
        .iter()
        .any(|prompt| prompt.path.ends_with("hello.md")));
    assert!(manager
        .remove_and_persist(source, UserOrProject::User)
        .unwrap());
    assert_eq!(manager.list_configured_packages().len(), 1);
}

#[test]
fn git_clone_update_remove_flow() {
    let _guard = super::test_support::ENV_MUTEX.lock().unwrap();
    let sandbox = Sandbox::new("git-flow");
    let (bare, work) = make_bare_repo(&sandbox.root);

    let source = GitSource {
        repo: bare.display().to_string(),
        host: "localhost".to_string(),
        path: "fixtures/repo".to_string(),
        r#ref: None,
        pinned: false,
    };
    super::git::install_git(&source, SourceScope::User, &sandbox.cwd, &sandbox.agent_dir).unwrap();

    let installed = sandbox
        .agent_dir
        .join("git")
        .join("localhost")
        .join("fixtures")
        .join("repo");
    assert!(installed.join("package.json").exists());
    assert!(sandbox.agent_dir.join("git").join(".gitignore").exists());

    // Move main in the work clone; the update's fetch + reset lands it.
    std::fs::write(work.join("skills.md"), "v2 content").unwrap();
    run_git(&work, &["add", "."]);
    run_git(&work, &["commit", "-qm", "v2"]);
    run_git(&work, &["push", "-q", "origin", "main"]);
    super::git::update_git(&source, SourceScope::User, &sandbox.cwd, &sandbox.agent_dir).unwrap();
    assert!(installed.join("skills.md").exists());

    super::git::update_git(&source, SourceScope::User, &sandbox.cwd, &sandbox.agent_dir).unwrap();

    super::git::remove_git(&source, SourceScope::User, &sandbox.cwd, &sandbox.agent_dir).unwrap();
    assert!(!installed.exists());
    assert!(!installed.parent().unwrap().exists());
    assert!(sandbox.agent_dir.join("git").join(".gitignore").exists());
}

#[test]
fn git_ref_checkout_installs_the_pinned_revision() {
    let _guard = super::test_support::ENV_MUTEX.lock().unwrap();
    let sandbox = Sandbox::new("git-ref");
    let dir_root = sandbox.root.clone();
    let (bare, work) = make_bare_repo(&dir_root);
    run_git(&work, &["tag", "v1"]);
    std::fs::write(work.join("skills.md"), "moved").unwrap();
    run_git(&work, &["add", "."]);
    run_git(&work, &["commit", "-qm", "moved"]);
    run_git(&work, &["push", "-q", "origin", "main"]);
    run_git(&work, &["push", "-q", "origin", "v1"]);

    let source = GitSource {
        repo: bare.display().to_string(),
        host: "localhost".to_string(),
        path: "fixtures/repo".to_string(),
        r#ref: Some("v1".to_string()),
        pinned: true,
    };
    super::git::install_git(&source, SourceScope::User, &sandbox.cwd, &sandbox.agent_dir).unwrap();
    let installed = sandbox
        .agent_dir
        .join("git")
        .join("localhost")
        .join("fixtures")
        .join("repo");
    assert!(installed.join("package.json").exists());
    assert!(!installed.join("skills.md").exists(), "pinned ref checkout");
}

/// A launcher symlink resolves to the real binary's directory (the
/// Homebrew formula's `bin` link): the shipped payload sits beside the
/// real file, and a plain path stays untouched.
#[cfg(unix)]
#[test]
fn exe_dir_of_resolves_a_launcher_symlink() {
    let root = tempfile::tempdir().unwrap();
    // exe_dir_of returns a canonical path; macOS temp dirs sit behind the /var symlink.
    let root_path = root.path().canonicalize().unwrap();
    let libexec = root_path.join("libexec");
    let bin = root_path.join("bin");
    std::fs::create_dir_all(&libexec).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(libexec.join("wasmedge-agent"), b"binary").unwrap();
    let launcher = bin.join("wasmedge-agent");
    std::os::unix::fs::symlink(libexec.join("wasmedge-agent"), &launcher).unwrap();
    let real = libexec.join("wasmedge-agent");
    assert_eq!(exe_dir_of(&launcher), Some(libexec.clone()));
    assert_eq!(exe_dir_of(&real), Some(libexec));
}
