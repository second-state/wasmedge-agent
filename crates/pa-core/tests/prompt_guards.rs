// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines/casts).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Prompt guard tests: cache safety (static layers never contain dynamic content; the cached prefix
//! is byte-identical across sessions) and tool surface (the core layer's documented tools match the
//! real registered surface; a tool change without a prompt update fails here).

use std::path::Path;

use pa_core::prompts::layers::{CORE_LAYER, OPINIONATED_LAYER, USAGE_LAYER};
use pa_core::prompts::model_prompts::MODEL_PROMPTS_TOML;
use pa_core::prompts::system_prompt::{
    system_prompt_breakdown, BuildSystemPromptOptions, SegmentKind,
};
use pa_core::resources::{ContextFile, LoadedResources};
use pa_core::settings::{Settings, SettingsManager};
use pa_core::skills::{load_skills_from_dir, Skill};

/// The workspace bundled skills directory (source-checkout layout):
/// pa-core lives at `<root>/crates/pa-core`.
fn bundled_skills_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("workspace root")
        .join("packages/coding-agent/skills")
}

fn sorted_bundled_skills() -> Vec<Skill> {
    let skills_dir = bundled_skills_dir();
    let mut loaded = load_skills_from_dir(&skills_dir, "package");
    loaded
        .skills
        .sort_by(|left, right| left.name.cmp(&right.name));
    loaded.skills
}

fn default_settings() -> SettingsManager {
    SettingsManager::in_memory(&Settings::default())
}

/// A root daemon session's prompt inputs over borrowed settings,
/// resources, and skills.
fn session_options<'a>(
    settings: &'a SettingsManager,
    resources: &'a LoadedResources,
    skills: &'a [Skill],
) -> BuildSystemPromptOptions<'a> {
    BuildSystemPromptOptions {
        settings,
        resources,
        skills,
        selected_tools: vec!["rust", "bash"],
        model_prompt_extras: None,
        model_input: &[],
        cwd: "/w".to_string(),
        messages_path: Some("/log.jsonl".to_string()),
        generic_mcp_servers: Vec::new(),
        rlm_depth: 0,
        factory_child: false,
        daemonless: false,
        can_spawn: false,
    }
}

// Cache safety

/// Strings that only dynamic segments generate. If one of these ever appears in a static layer
/// file, the cached prefix has started leaking per-session content.
const DYNAMIC_ONLY_MARKERS: &[&str] = &[
    "Working directory:",
    "Conversation log:",
    "Recursive agent depth:",
    "Current date:",
    "<available_skills>",
    "Enabled generic MCP servers:",
    "# Project Context",
    "The agent_lib prelude",
    "You are a child agent spawned by",
];

#[test]
fn static_layers_contain_no_dynamic_content() {
    for (name, text) in [
        ("core", CORE_LAYER),
        ("usage", USAGE_LAYER),
        ("opinionated", OPINIONATED_LAYER),
        ("model-prompts", MODEL_PROMPTS_TOML),
    ] {
        for marker in DYNAMIC_ONLY_MARKERS {
            assert!(
                !text.contains(marker),
                "static layer {name} contains dynamic-only marker {marker:?}: \
                 dynamic content must stay in the tail, not the cacheable prefix"
            );
        }
    }
}

#[test]
fn cached_prefix_is_stable_across_sessions() {
    let skills = sorted_bundled_skills();
    let settings = default_settings();
    let resources = LoadedResources::default();
    let mut options = session_options(&settings, &resources, &skills);
    options.cwd = "/first/cwd".to_string();
    options.messages_path = Some("/first/session.jsonl".to_string());
    options.model_prompt_extras = Some("model guidance.");
    let first = system_prompt_breakdown(&options);

    let other_settings = SettingsManager::in_memory(
        &serde_json::from_value(serde_json::json!({ "agentInbox": { "enabled": false } })).unwrap(),
    );
    let other_resources = LoadedResources {
        agents_files: vec![ContextFile {
            path: "AGENTS.md".into(),
            content: "Never commit main.".into(),
        }],
        append_system_prompt: vec!["And one more thing.".into()],
        ..Default::default()
    };
    let mut options = session_options(&other_settings, &other_resources, &skills);
    options.cwd = "/completely/different".into();
    options.messages_path = None;
    options.model_prompt_extras = Some("model guidance.");
    options.rlm_depth = 3;
    options.generic_mcp_servers = vec!["slack".into(), "github".into()];
    let second = system_prompt_breakdown(&options);

    assert_eq!(first.cached_prefix_len, second.cached_prefix_len);
    assert_eq!(
        &first.assembled[..first.cached_prefix_len],
        &second.assembled[..second.cached_prefix_len]
    );
    assert_eq!(
        &first.assembled[..first.cached_prefix_len],
        &format!(
            "{}\n\n{}\n\n{}\n\nmodel guidance.",
            CORE_LAYER.trim(),
            USAGE_LAYER.trim(),
            OPINIONATED_LAYER.trim()
        )
    );

    let first_tail = &first.assembled[first.cached_prefix_len..];
    assert!(first_tail.contains("Current date: "));
    assert!(first_tail.contains("Working directory: /first/cwd"));
    assert!(first_tail.contains("Recursive agent depth: 0 (root)"));
    assert!(first_tail.contains("<available_skills>"));
    assert!(first_tail.contains("The agent_lib prelude"));
    let second_tail = &second.assembled[second.cached_prefix_len..];
    assert!(second_tail.contains("/completely/different"));
    assert!(second_tail.contains("Enabled generic MCP servers: `github`, `slack`."));
    assert!(second_tail.contains("Recursive agent depth: 3 (not root)"));
    assert!(second_tail.contains("You are a child agent spawned by your parent agent."));
    assert!(second_tail.contains("# Project Context"));
    assert!(second_tail.ends_with("And one more thing."));

    for segment in &first.segments {
        let inside = first
            .assembled
            .find(&segment.text)
            .is_some_and(|at| at < first.cached_prefix_len);
        assert_eq!(
            inside,
            segment.kind == SegmentKind::Static,
            "segment {} on the wrong side of the cache boundary",
            segment.name
        );
    }
}

#[test]
fn prompt_describes_registered_wasmedge_tools_and_guest_state() {
    for token in [
        "`rust`",
        "`bash`",
        "wasm32-wasip1",
        "rlm::state::set",
        "rlm::state::get",
        "agent_lib",
    ] {
        assert!(CORE_LAYER.contains(token), "missing {token}");
    }
    let skills = sorted_bundled_skills();
    assert!(skills.iter().any(|s| s.name == "skill-creator"));
    assert!(skills
        .iter()
        .any(|s| s.name == "websearch" && s.kind_label() == "rust"));
    assert!(!CORE_LAYER.contains("python_repl"));
}
