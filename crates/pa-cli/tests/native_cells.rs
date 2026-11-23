//! Offline product test using the public executable, a scripted provider and real WASI modules.
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn cell(body: &str, edits: Value) -> Value {
    let mut args = json!({"code":format!("use agent_lib::prelude::*; fn main() -> Result<()> {{ {body}; Ok(()) }}")});
    if !edits.is_null() {
        args["lib"] = edits;
    }
    json!({"content":[{"type":"toolCall","name":"rust","arguments":args}]})
}
struct Fixture {
    root: tempfile::TempDir,
}
impl Fixture {
    fn run(&self, args: &[&str], script: Value) -> Vec<Value> {
        let root = self.root.path();
        let binary = env!("CARGO_BIN_EXE_wasmedge-agent");
        let output = Command::new(binary)
            .arg("--offline")
            .args(args)
            .current_dir(root.join("project"))
            .env("DO_NOT_TRACK", "1")
            .env("WASMEDGE_AGENT_CODING_AGENT_DIR", root.join("agent"))
            .env("WASMEDGE_AGENT_SESSION_DIR", root.join("sessions"))
            .env("WASMEDGE_AGENT_FAUX_SCRIPT", script.to_string())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "CLI failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    fn cells(&self, args: &[&str], responses: Value, children: Value) -> Vec<String> {
        let mut flags = vec!["--mode", "json", "-p", "Run the fixture"];
        flags.extend(args);
        let mut script = json!({"responses":responses,"repeatLastResponse":true});
        if !children.is_null() {
            script["children"] = children;
        }
        self.run(&flags, script)
            .into_iter()
            .filter(|e| e["type"] == "tool_execution_end")
            .map(|e| {
                e["result"]["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|b| b["text"].as_str())
                    .collect()
            })
            .collect()
    }
}
fn transcript(dir: &Path) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_file() && p.extension().is_some_and(|s| s == "jsonl") {
            return Some(p);
        }
        if p.is_dir() && p.file_name().is_some_and(|n| n != "session-artifacts") {
            if let Some(s) = transcript(&p) {
                return Some(s);
            }
        }
    }
    None
}
fn workspace_in(dir: &Path) -> Option<PathBuf> {
    for entry in fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
    {
        let next = entry.path();
        if next.join(".workspace-version").is_file() {
            return Some(next);
        }
        if let Some(ws) = workspace_in(&next) {
            return Some(ws);
        }
    }
    None
}
#[test]
#[ignore = "requires WasmEdge, wasm32-wasip1 and a vendored guest template"]
fn native_tools_resume_inherit_and_refine() {
    let fixture = Fixture {
        root: tempfile::tempdir().unwrap(),
    };
    let root = fixture.root.path();
    fs::create_dir(root.join("project")).unwrap();
    fs::create_dir(root.join("agent")).unwrap();
    fs::write(root.join("agent/settings.json"), r#"{"rlmMaxDepth":3}"#).unwrap();
    let helper = "src/helpers/answer.rs";
    let first=fixture.cells(&[],json!([
        cell(r#"rlm::state::set("n",&41)?; println!("saved={} depth={}/{}",helpers::answer::next(40),std::env::var("RLM_DEPTH")?,std::env::var("RLM_MAX_DEPTH")?)"#,json!([{"path":helper,"content":"pub fn next(n:i64)->i64 {n+1}"}])),
        cell("",json!([{"path":helper,"content":"pub fn next("}])),"first turn complete"
    ]),Value::Null);
    assert_eq!(first.len(), 2, "{first:?}");
    assert!(first[0].contains("saved=41 depth=0/3"), "{}", first[0]);
    assert!(first[1].contains("error"), "{}", first[1]);
    let ws = workspace_in(root).expect("persistent cell workspace");
    let original = fs::read(ws.join("cell/src/main.rs")).unwrap();
    assert!(
        String::from_utf8_lossy(&original).contains("saved="),
        "failed build must restore the previous cell source"
    );
    let file = transcript(&root.join("sessions")).unwrap();
    let resume = ["--resume", file.to_str().unwrap()];
    let version_file = ws.join(".workspace-version");
    let mut legacy: Value = serde_json::from_slice(&fs::read(&version_file).unwrap()).unwrap();
    legacy["wasmedgeVersion"] = "previous runtime".into();
    let legacy = serde_json::to_vec(&legacy).unwrap();
    fs::write(&version_file, &legacy).unwrap();
    let library = ws.join("agent_lib").join(helper);
    let retained = fs::read(&library).unwrap();
    fs::write(&library, "pub fn broken(").unwrap();
    let failed = fixture.cells(
        &resume,
        json!([cell("println!(\"unreachable\")", Value::Null), "finished"]),
        Value::Null,
    );
    assert!(
        failed
            .iter()
            .any(|s| s.contains("workspace upgrade validation")),
        "{failed:?}"
    );
    assert_eq!(fs::read(&version_file).unwrap(), legacy);
    assert_eq!(fs::read(ws.join("cell/src/main.rs")).unwrap(), original);
    assert_eq!(fs::read(&library).unwrap(), b"pub fn broken(");
    fs::write(&library, retained).unwrap();
    let second=fixture.cells(&resume,json!([
        cell(r#"let n:i64=rlm::state::get("n")?.unwrap(); let info=rlm::host_request("model.info",json!({}))?; println!("native={} resumed={}",info["id"],helpers::answer::next(n))"#,Value::Null),
        {"content":[{"type":"toolCall","name":"bash","arguments":{"command":"echo native-host-shell"}}]},
        cell(r#"let h=rlm::spawn_named("check inherited library","child")?; println!("child={}",h.name)"#,Value::Null),"parent complete"]),
        json!({"child":{"responses":[cell(r#"std::fs::write("/workspace/child-result",format!("inherited={} depth={}/{}",helpers::answer::next(6),std::env::var("RLM_DEPTH")?,std::env::var("RLM_MAX_DEPTH")?))?"#,Value::Null),"child complete"]}}));
    assert_eq!(second.len(), 3, "{second:?}");
    assert!(
        second[0].contains("native=\"faux-1\" resumed=42"),
        "{}",
        second[0]
    );
    assert!(second[1].contains("native-host-shell"));
    assert!(second[2].contains("child=child"), "{}", second[2]);
    assert_eq!(
        fs::read_to_string(root.join("project/child-result")).unwrap(),
        "inherited=7 depth=1/3"
    );
    let mut edits = vec![];
    for (name, expected) in [("passing-native", 7), ("failing-native", 8)] {
        let krate = name.replace('-', "_");
        let dir = root.join("agent/skills").join(name);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!(
                "---\nname: {name}\ndescription: Native refinement fixture\n---\nRun the crate.\n"
            ),
        )
        .unwrap();
        fs::write(
            dir.join("Cargo.toml"),
            format!("[package]\nname = \"{krate}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"),
        )
        .unwrap();
        fs::write(
            dir.join("src/lib.rs"),
            format!(
                "pub fn run()->i32{{7}} #[test] fn verifies(){{assert_eq!(run(),{expected});}}"
            ),
        )
        .unwrap();
        edits.push(json!({"action":"create","kind":"skill","id":name,"title":name,"content":"Return the result","arguments":{},"reference":{"type":"rust","use":format!("agent_lib::skills::{krate}"),"callable":"run"}}));
    }
    let events=fixture.run(&[resume[0],resume[1],"--mode","json","-p","/refine"],json!({"responses":[json!({"summary":"Register tested skills","edits":edits}).to_string()],"repeatLastResponse":true}));
    let result = &events
        .iter()
        .find(|e| e["type"] == "refine_complete")
        .unwrap()["result"];
    assert!(
        result["appliedEdits"][0]["applied"] == true,
        "{}",
        result["appliedEdits"]
    );
    assert!(
        result["appliedEdits"][1]["applied"] == false,
        "{}",
        result["appliedEdits"]
    );
    let state: Value =
        serde_json::from_slice(&fs::read(result["harnessStatePath"].as_str().unwrap()).unwrap())
            .unwrap();
    assert!(state["entries"]["skill"]["passing-native"].is_object());
    assert!(state["entries"]["skill"]["failing-native"].is_null());
    fixture.cells(
        &[resume[0], resume[1], "--tools", "bash"],
        json!([
            cell(
                r#"std::fs::write("/workspace/forbidden","unexpected")?"#,
                Value::Null
            ),
            "complete"
        ]),
        Value::Null,
    );
    assert!(!root.join("project/forbidden").exists());
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires Linux user namespaces, delegated cgroup v2, WasmEdge and the WASI target"]
fn native_compiler_and_guest_run_with_requested_linux_limits() {
    let fixture = Fixture {
        root: tempfile::tempdir().unwrap(),
    };
    let root = fixture.root.path();
    fs::create_dir(root.join("project")).unwrap();
    fs::create_dir(root.join("agent")).unwrap();
    fs::write(root.join("agent/settings.json"),json!({"rustCell":{"cargoSandbox":"bubblewrap","cellTimeoutMs":180000,"processLimits":{"tasksMax":256,"memoryMaxMb":2048},"treeProcessLimits":{"tasksMax":512,"memoryMaxMb":3072}}}).to_string()).unwrap();
    let output = fixture.cells(
        &[],
        json!([cell(r#"println!("scoped guest")"#, Value::Null), "done"]),
        Value::Null,
    );
    assert!(
        output.iter().any(|s| s.contains("scoped guest")),
        "{output:?}"
    );
}

#[test]
#[ignore = "requires the pinned rustdoc toolchain, WasmEdge and the WASI target"]
fn native_rustdoc_resolves_reexports_methods_and_private_configuration() {
    let fixture = Fixture {
        root: tempfile::tempdir().unwrap(),
    };
    let root = fixture.root.path();
    fs::create_dir(root.join("project")).unwrap();
    fs::create_dir(root.join("agent")).unwrap();
    fs::write(
        root.join("agent/settings.json"),
        r#"{"rustCell":{"rustdocToolchain":"nightly-2026-09-25","cellTimeoutMs":180000}}"#,
    )
    .unwrap();
    let source="pub struct Output; impl Output { pub fn count(&self)->usize {1} } pub use Output as PublicAlias;";
    let code = r#"let alias=rlm::api::describe("agent_lib::helpers::sample::PublicAlias::count")?; println!("documented={}",alias["items"][0]["kind"]); let private=rlm::host_request("mcp.config",json!({"server":"fixture"})); println!("private={}",private.is_err())"#;
    let output = fixture.cells(
        &[],
        json!([
            cell(
                code,
                json!([{"path":"src/helpers/sample.rs","content":source}])
            ),
            "done"
        ]),
        Value::Null,
    );
    assert!(
        output
            .iter()
            .any(|s| s.contains("documented=\"function\"") && s.contains("private=true")),
        "{output:?}"
    );
}
