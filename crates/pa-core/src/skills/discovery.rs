//! Skill directory discovery.

use std::path::{Path, PathBuf};

use super::diagnostics::ResourceDiagnostic;
use super::frontmatter::parse_frontmatter;
use super::skill_markdown_name;
use super::{
    create_synthetic_source_info, validate_skill_description, validate_skill_name, Skill,
    SkillKind, SourceScope,
};

/// Sources that pick up a synthetic scope.
fn scope_for_source(source: &str) -> SourceScope {
    match source {
        "user" => SourceScope::User,
        "project" => SourceScope::Project,
        _ => SourceScope::Temporary,
    }
}

pub(crate) fn load_skill_from_file(
    file_path: &Path,
    source: &str,
) -> (Option<Skill>, Vec<ResourceDiagnostic>) {
    let mut diagnostics = Vec::new();
    let raw_content = match std::fs::read_to_string(file_path) {
        Ok(content) => content,
        Err(error) => {
            diagnostics.push(ResourceDiagnostic::Warning {
                message: error.to_string(),
                path: Some(file_path.display().to_string()),
            });
            return (None, diagnostics);
        }
    };
    let frontmatter = match parse_frontmatter(&raw_content).0 {
        Ok(frontmatter) => frontmatter,
        Err(error) => {
            diagnostics.push(ResourceDiagnostic::Warning {
                message: format!("invalid YAML frontmatter: {error}"),
                path: Some(file_path.display().to_string()),
            });
            return (None, diagnostics);
        }
    };
    let skill_dir = file_path.parent().unwrap_or_else(|| Path::new("."));
    let parent_dir_name = skill_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();

    let description = frontmatter
        .get("description")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    for error in validate_skill_description(&description) {
        diagnostics.push(ResourceDiagnostic::Warning {
            message: error,
            path: Some(file_path.display().to_string()),
        });
    }

    // TS `frontmatter.name || parentDirName`: a falsy name (missing or the
    // empty string) falls back to the parent directory name.
    let name = frontmatter
        .get("name")
        .and_then(|value| value.as_str())
        .filter(|name| !name.is_empty())
        .map_or_else(|| parent_dir_name.clone(), str::to_string);

    for error in validate_skill_name(&name, &parent_dir_name) {
        diagnostics.push(ResourceDiagnostic::Warning {
            message: error,
            path: Some(file_path.display().to_string()),
        });
    }

    if description.trim().is_empty() {
        return (None, diagnostics);
    }

    let rust_crate = file_path.ends_with("SKILL.md")
        && skill_dir.join("Cargo.toml").is_file()
        && skill_dir.join("src/lib.rs").is_file();
    let skill = Skill {
        name,
        description,
        file_path: file_path.to_path_buf(),
        base_dir: skill_dir.to_path_buf(),
        source_info: create_synthetic_source_info(
            &file_path.display().to_string(),
            source,
            scope_for_source(source),
            Some(&skill_dir.display().to_string()),
        ),
        disable_model_invocation: frontmatter
            .get("disable-model-invocation")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        kind: if rust_crate {
            SkillKind::Rust
        } else {
            SkillKind::Markdown
        },
        python: None,
    };
    (Some(skill), diagnostics)
}

/// Where the discovery recursion keeps shared ignore rules. Lines accumulate
/// (source file, prefixed pattern) pairs; the matcher rebuilds on demand.
struct DiscoveryState {
    root: PathBuf,
    lines: Vec<(PathBuf, String)>,
}

impl DiscoveryState {
    fn add_ignore_rules(&mut self, dir: &Path) {
        let relative = dir.strip_prefix(&self.root).unwrap_or(dir);
        let prefix = if relative.as_os_str().is_empty() {
            String::new()
        } else {
            format!("{}/", relative.to_string_lossy().replace('\\', "/"))
        };
        for filename in [".gitignore", ".ignore", ".fdignore"] {
            let ignore_path = dir.join(filename);
            let Ok(content) = std::fs::read_to_string(&ignore_path) else {
                continue;
            };
            let patterns: Vec<String> = content
                .lines()
                .filter_map(|line| prefix_ignore_pattern(line, &prefix))
                .collect();
            for pattern in patterns {
                self.lines.push((ignore_path.clone(), pattern));
            }
        }
    }

    fn ignores(&self, rel_path: &str, is_dir: bool) -> bool {
        let mut builder = ignore::gitignore::GitignoreBuilder::new(&self.root);
        for (source, line) in &self.lines {
            let _ = builder.add_line(Some(source.clone()), line);
        }
        let matcher = builder
            .build()
            .unwrap_or_else(|_| ignore::gitignore::Gitignore::empty());
        matches!(matcher.matched(rel_path, is_dir), ignore::Match::Ignore(_))
    }
}

fn prefix_ignore_pattern(line: &str, prefix: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('#') && !trimmed.starts_with("\\#") {
        return None;
    }
    let mut pattern = line.to_string();
    let mut negated = false;
    if pattern.starts_with('!') {
        negated = true;
        pattern = pattern[1..].to_string();
    } else if pattern.starts_with("\\!") {
        pattern = pattern[1..].to_string();
    }
    if pattern.starts_with('/') {
        pattern = pattern[1..].to_string();
    }
    let prefixed = format!("{prefix}{pattern}");
    Some(if negated {
        format!("!{prefixed}")
    } else {
        prefixed
    })
}

pub struct LoadSkillsFromDirResult {
    pub skills: Vec<Skill>,
    pub diagnostics: Vec<ResourceDiagnostic>,
}

/// Discovery rules:
/// - a directory containing SKILL.md is a skill root; no further recursion
/// - otherwise direct .md children of the root count as skills
/// - recurse into subdirectories looking for SKILL.md
#[must_use]
pub fn load_skills_from_dir(dir: &Path, source: &str) -> LoadSkillsFromDirResult {
    let state = DiscoveryState {
        root: dir.to_path_buf(),
        lines: Vec::new(),
    };
    load_skills_from_dir_internal(dir, source, true, state).0
}

fn load_skills_from_dir_internal(
    dir: &Path,
    source: &str,
    include_root_files: bool,
    mut state: DiscoveryState,
) -> (LoadSkillsFromDirResult, DiscoveryState) {
    let mut skills = Vec::new();
    let mut diagnostics = Vec::new();
    if !dir.is_dir() {
        return (
            LoadSkillsFromDirResult {
                skills,
                diagnostics,
            },
            state,
        );
    }
    state.add_ignore_rules(dir);

    let Ok(entries) = std::fs::read_dir(dir) else {
        return (
            LoadSkillsFromDirResult {
                skills,
                diagnostics,
            },
            state,
        );
    };
    let mut names: Vec<(PathBuf, bool, bool)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name != "SKILL.md" {
            continue;
        }
        let path = entry.path();
        let meta = std::fs::metadata(&path).ok();
        let is_file = meta.as_ref().is_some_and(std::fs::Metadata::is_file);
        names.push((path, is_file, false));
    }
    // SKILL.md in this directory: stop after loading it.
    if let Some((path, is_file, _)) = names.first() {
        let rel = path
            .strip_prefix(&state.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if *is_file && !state.ignores(&rel, false) {
            let (skill, file_diagnostics) = load_skill_from_file(path, source);
            if let Some(skill) = skill {
                skills.push(skill);
            }
            diagnostics.extend(file_diagnostics);
        }
        return (
            LoadSkillsFromDirResult {
                skills,
                diagnostics,
            },
            state,
        );
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return (
            LoadSkillsFromDirResult {
                skills,
                diagnostics,
            },
            state,
        );
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        let meta = std::fs::metadata(&path).ok();
        let (is_dir, is_file) = match meta {
            Some(meta) => (meta.is_dir(), meta.is_file()),
            None => continue,
        };
        let rel = path
            .strip_prefix(&state.root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let ignore_path = if is_dir { format!("{rel}/") } else { rel };
        if state.ignores(&ignore_path, is_dir) {
            continue;
        }
        if is_dir {
            // Recurse: children inherit this dir's ignore rules; sibling
            // directories see rules children discovered too (TS shares one ig).
            let sub_state = DiscoveryState {
                root: state.root.clone(),
                lines: state.lines.clone(),
            };
            let (sub, sub_state) = load_skills_from_dir_internal(&path, source, false, sub_state);
            state.lines = sub_state.lines;
            skills.extend(sub.skills);
            diagnostics.extend(sub.diagnostics);
            continue;
        }
        if !is_file || !include_root_files || !skill_markdown_name(&name) {
            continue;
        }
        let (skill, file_diagnostics) = load_skill_from_file(&path, source);
        if let Some(skill) = skill {
            skills.push(skill);
        }
        diagnostics.extend(file_diagnostics);
    }
    (
        LoadSkillsFromDirResult {
            skills,
            diagnostics,
        },
        state,
    )
}
