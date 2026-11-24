use anyhow::{ensure, Context, Result};
use fancy_regex::Regex;
use globset::{GlobBuilder, GlobMatcher};
use serde::Deserialize;
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::Path,
    process::Command,
};

#[derive(Deserialize)]
struct Rules {
    rules: Vec<Rule>,
    names: BTreeSet<String>,
    allows: Vec<Allow>,
    pins: Vec<Pin>,
}
#[derive(Deserialize)]
struct Rule {
    pattern: String,
    label: String,
}
#[derive(Deserialize)]
struct Allow {
    glob: String,
    patterns: Vec<String>,
    reason: String,
}
#[derive(Deserialize)]
struct Pin {
    glob: String,
    literal: String,
}
fn glob(path: &str) -> Result<GlobMatcher> {
    Ok(GlobBuilder::new(path)
        .literal_separator(true)
        .build()?
        .compile_matcher())
}
pub(crate) fn tracked(root: &Path) -> Result<Vec<String>> {
    let git = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(root)
        .output()?;
    ensure!(git.status.success(), "git ls-files failed");
    Ok(String::from_utf8(git.stdout)?
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect())
}
/// Keep project and release inputs usable without a JavaScript runtime.
pub(crate) fn native_sources(root: &Path, files: &[String]) -> Result<()> {
    let executable_html = regex::Regex::new(
        r#"(?is)<script[\s/>]|<[a-z][^>]*\s(?:on[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*javascript:)"#,
    )?;
    for file in files {
        let path = Path::new(file);
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        ensure!(
            !matches!(
                extension.as_str(),
                "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts"
            ) && !matches!(
                name.as_str(),
                "package.json"
                    | "package-lock.json"
                    | "npm-shrinkwrap.json"
                    | "yarn.lock"
                    | "pnpm-lock.yaml"
                    | "bun.lock"
                    | "bun.lockb"
                    | "deno.json"
                    | "deno.jsonc"
                    | "deno.lock"
            ) && !path.components().any(|c| c.as_os_str() == "node_modules"),
            "JavaScript or package-manager input in Git: {file}"
        );
        if matches!(extension.as_str(), "html" | "htm" | "svg") {
            let contents = fs::read_to_string(root.join(path))?;
            ensure!(
                !executable_html.is_match(&contents),
                "executable JavaScript in {file}"
            );
        }
    }
    Ok(())
}

pub(crate) fn branding(root: &Path, files: &[String]) -> Result<()> {
    let rules: Rules = serde_json::from_str(include_str!("branding.json"))?;
    let forbidden = rules
        .rules
        .iter()
        .map(|r| {
            Ok((
                Regex::new(&r.pattern).with_context(|| r.label.clone())?,
                &r.label,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let allows = rules
        .allows
        .iter()
        .map(|a| {
            Ok((
                glob(&a.glob)?,
                a.patterns
                    .iter()
                    .map(|s| Regex::new(s))
                    .collect::<Result<Vec<_>, _>>()?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let pins = rules
        .pins
        .iter()
        .map(|p| glob(&p.glob))
        .collect::<Result<Vec<_>>>()?;
    let env = regex::Regex::new(r"\bWASMEDGE_AGENT_[A-Z0-9_]+")?;
    let needles = regex::Regex::new("(?i)prime|wasmedge|earendil|/pi-")?;
    let mut used = HashSet::new();
    let mut found = HashSet::new();
    let mut errors = Vec::new();
    for path in files {
        let Ok(content) = fs::read_to_string(root.join(path)) else {
            continue;
        };
        for (i, p) in rules.pins.iter().enumerate() {
            if pins[i].is_match(path) && content.contains(&p.literal) {
                found.insert(i);
            }
        }
        let covers = |p: &str| {
            allows
                .iter()
                .enumerate()
                .filter(|(_, a)| a.0.is_match(p))
                .map(|(i, _)| i)
                .collect::<Vec<_>>()
        };
        let file_rules = covers(path);
        let unreleased = covers(&format!("{path}#unreleased"));
        let mut pending = String::new();
        let mut draft = false;
        for (number, line) in std::iter::once(path.as_str())
            .chain(content.lines())
            .enumerate()
        {
            if path.ends_with("CHANGELOG.md") && line.trim_start().starts_with("## ") {
                draft = line.to_ascii_lowercase().contains("unreleased");
            }
            let scopes = if draft { &unreleased } else { &file_rules };
            // Check the neighbouring words too: Markdown renders a soft break as a space.
            let first = line.split_whitespace().next().unwrap_or("");
            let seam = format!("{pending} {first}");
            pending = line.split_whitespace().last().unwrap_or("").to_owned();
            for sample in [line, seam.as_str()] {
                if !needles.is_match(sample) {
                    continue;
                }
                let mut raw = Vec::new();
                for (re, label) in &forbidden {
                    if re.is_match(sample)? {
                        raw.push(label.as_str());
                    }
                }
                for name in env.find_iter(sample).map(|m| m.as_str()) {
                    if !rules.names.contains(name)
                        && !name.starts_with("WASMEDGE_AGENT_INTERNAL_")
                        && !name.starts_with("WASMEDGE_AGENT_TEST_")
                    {
                        raw.push(name);
                    }
                }
                if raw.is_empty() {
                    continue;
                }
                let mut masked = sample.to_owned();
                let mut applied = Vec::new();
                for idx in scopes {
                    for re in &allows[*idx].1 {
                        let next = re.replace_all(&masked, " ").into_owned();
                        if next != masked {
                            applied.push(*idx);
                            masked = next;
                        }
                    }
                }
                let mut hits = Vec::new();
                for (re, label) in &forbidden {
                    if re.is_match(&masked)? {
                        hits.push(label.as_str());
                    }
                }
                for name in env.find_iter(&masked).map(|m| m.as_str()) {
                    if !rules.names.contains(name)
                        && !name.starts_with("WASMEDGE_AGENT_INTERNAL_")
                        && !name.starts_with("WASMEDGE_AGENT_TEST_")
                    {
                        hits.push(name);
                    }
                }
                if hits.len() < raw.len() {
                    used.extend(applied);
                }
                if !hits.is_empty() && sample == line {
                    errors.push(format!("{path}:{number}: {}", hits.join(", ")));
                }
                if sample == seam
                    && (seam.eq_ignore_ascii_case("Prime Agent")
                        || seam.eq_ignore_ascii_case("Prime Intellect")
                        || seam.eq_ignore_ascii_case("Prime brand"))
                    && !hits.is_empty()
                {
                    errors.push(format!("{path}:{number}: split brand name {seam}"));
                }
            }
        }
    }
    for (i, a) in rules.allows.iter().enumerate() {
        if !used.contains(&i) {
            errors.push(format!("unused exception {}: {}", a.glob, a.reason));
        }
    }
    for (i, p) in rules.pins.iter().enumerate() {
        if !found.contains(&i) {
            errors.push(format!("missing {} in {}", p.literal, p.glob));
        }
    }
    ensure!(errors.is_empty(), "{}", errors.join("\n"));
    Ok(())
}
pub(crate) fn reports(root: &Path, files: &[String]) -> Result<()> {
    let standalone = [
        "docs/rust-cell-report-2026-10-08.html",
        "docs/rust-cell-report-2026-10-08.en.html",
    ];
    let docs = regex::Regex::new(
        r"^(README\.md$|(DESIGN|REPORT)(\.en)?\.|examples/showcase/README\.md$|docs/README\.md$|docs/bench-history/|docs/(benchmark-(aot-bridge|cell-runtime-analysis|three-way-(design|validation)|rust-cell-(workloads|e2e)|comparison)|runtime-microbenchmark|rust-cell-report)|poc/bench/three-way/README)",
    )?;
    let strip = regex::Regex::new(
        r"(?is)<!--.*?-->|<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>",
    )?;
    let fences = regex::Regex::new(r"(?ms)^```[^\n]*\n.*?^```")?;
    let markdown = regex::Regex::new(r"\]\(([^)]+)\)")?;
    let html = regex::Regex::new(r#"(?i)\b(?:href|src)\s*=\s*["']([^"']+)["']"#)?;
    let external = regex::Regex::new(r"(?i)^(?:[a-z][a-z\d+.-]*:|//)")?;
    let tracked: HashSet<_> = files.iter().map(String::as_str).collect();
    let root = root.canonicalize()?;
    for file in files {
        ensure!(
            !file.starts_with("poc/bench/results/"),
            "raw benchmark output in Git: {file}"
        );
        if !docs.is_match(file) || !(file.ends_with(".md") || file.ends_with(".html")) {
            continue;
        }
        let source = root.join(file);
        let raw = fs::read_to_string(&source)?;
        let md = file.ends_with(".md");
        let body = if md {
            fences.replace_all(&raw, "")
        } else {
            strip.replace_all(&raw, "")
        };
        for link in (if md { &markdown } else { &html }).captures_iter(&body) {
            let target = link[1].replace("&amp;", "&");
            if external.is_match(&target) || target.is_empty() {
                continue;
            }
            let (path, anchor) = target.split_once('#').unwrap_or((&target, ""));
            let path = path.split('?').next().unwrap_or("");
            if standalone.contains(&file.as_str()) {
                ensure!(path.is_empty(), "standalone report depends on {target}");
            }
            if path.is_empty() && (!standalone.contains(&file.as_str()) || anchor.is_empty()) {
                continue;
            }
            let actual = if path.is_empty() {
                source.clone()
            } else {
                source.parent().context("document directory")?.join(
                    percent_encoding::percent_decode_str(path)
                        .decode_utf8()?
                        .as_ref(),
                )
            };
            let dest = actual
                .canonicalize()
                .with_context(|| format!("missing {target} linked from {file}"))?;
            let rel = dest
                .strip_prefix(&root)?
                .to_string_lossy()
                .replace('\\', "/");
            ensure!(
                dest.is_file() && tracked.contains(rel.as_str()),
                "untracked report link {file} -> {target}"
            );
            if !anchor.is_empty()
                && (rel.contains("rust-cell-report-2026-10-08")
                    || rel.contains("benchmark-rust-cell-") && rel.ends_with(".html"))
            {
                let html = fs::read_to_string(&dest)?;
                ensure!(
                    html.contains(&format!("id=\"{anchor}\""))
                        || html.contains(&format!("id='{anchor}'")),
                    "missing report anchor {target} in {file}"
                );
            }
        }
    }
    Ok(())
}
