//! Render a session tree once, keeping shared history and alternate branches in the document.
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::sync::LazyLock;

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use serde_json::Value;
use syntect::{highlighting::ThemeSet, html::highlighted_html_for_string, parsing::SyntaxSet};

use super::ansi_to_html::{ansi_to_html, escape_html};
use super::SessionExportData;

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);
static THEMES: LazyLock<ThemeSet> = LazyLock::new(ThemeSet::load_defaults);
static CLEANER: LazyLock<ammonia::Builder<'static>> = LazyLock::new(|| {
    let mut builder = ammonia::Builder::default();
    builder
        .add_tag_attributes("span", &["style"])
        .add_tag_attributes("pre", &["style"])
        .filter_style_properties(
            [
                "color",
                "background-color",
                "font-weight",
                "font-style",
                "text-decoration",
            ]
            .into(),
        )
        .url_relative(ammonia::UrlRelative::Deny);
    builder
});

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn code_block(source: &str, language: &str) -> String {
    // Large generated logs and minified files should still export promptly.
    if !language.is_empty() && source.len() <= 64 * 1024 && source.lines().all(|l| l.len() <= 2048)
    {
        if let Some(syntax) = SYNTAXES.find_syntax_by_token(language) {
            if let Ok(html) = highlighted_html_for_string(
                source,
                &SYNTAXES,
                syntax,
                &THEMES.themes["base16-ocean.dark"],
            ) {
                return html;
            }
        }
    }
    format!("<pre><code>{}</code></pre>", escape_html(source))
}

fn markdown(source: &str) -> String {
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    let mut parser = Parser::new_ext(source, opts);
    let events = std::iter::from_fn(|| match parser.next()? {
        Event::Start(Tag::CodeBlock(block)) => {
            let mut source = String::new();
            for event in parser.by_ref() {
                match event {
                    Event::End(TagEnd::CodeBlock) => break,
                    Event::Text(line) => source.push_str(&line),
                    _ => {}
                }
            }
            let language = match &block {
                CodeBlockKind::Fenced(info) => info.split_whitespace().next().unwrap_or(""),
                CodeBlockKind::Indented => "",
            };
            Some(Event::Html(code_block(&source, language).into()))
        }
        Event::Html(raw) | Event::InlineHtml(raw) => Some(Event::Text(raw)),
        event => Some(event),
    });
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, events);
    CLEANER.clean(&html).to_string()
}

fn details(label: &str, body: &str) -> String {
    format!(
        "<details><summary>{}</summary>{body}</details>",
        escape_html(label)
    )
}

fn json(value: &Value) -> String {
    let pretty = serde_json::to_string_pretty(value).unwrap_or_default();
    format!("<pre>{}</pre>", escape_html(&pretty))
}

fn custom_tool(data: &SessionExportData, id: &str, key: &str) -> Option<String> {
    let html = data.rendered_tools.as_ref()?.get(id)?.get(key)?.as_str()?;
    Some(CLEANER.clean(html).to_string())
}

fn content(out: &mut String, value: &Value, tool_output: bool, data: &SessionExportData) {
    let render_text = |s: &str| {
        if tool_output {
            format!("<pre>{}</pre>", ansi_to_html(s))
        } else {
            markdown(s)
        }
    };
    if let Some(s) = value.as_str() {
        out.push_str(&render_text(s));
        return;
    }
    let Some(blocks) = value.as_array() else {
        return;
    };
    for block in blocks {
        match text(block, "type") {
            "text" => out.push_str(&render_text(text(block, "text"))),
            "thinking" => out.push_str(&details("Thinking", &markdown(text(block, "thinking")))),
            "toolCall" => {
                let title = format!("Tool call · {}", text(block, "name"));
                let body = custom_tool(data, text(block, "id"), "callHtml")
                    .unwrap_or_else(|| json(&block["arguments"]));
                out.push_str(&details(&title, &body));
            }
            "image" => {
                let mime = text(block, "mimeType");
                let bytes = text(block, "data");
                if matches!(
                    mime,
                    "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                ) && !bytes.is_empty()
                    && bytes
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"+/=\r\n".contains(&c))
                {
                    let _ = write!(out, "<img loading=\"lazy\" alt=\"Session attachment\" src=\"data:{mime};base64,{bytes}\">");
                } else {
                    out.push_str("<p>Image attachment unavailable</p>");
                }
            }
            _ => out.push_str(&details("Content block", &json(block))),
        }
    }
}

fn message_body(message: &Value, data: &SessionExportData) -> String {
    let mut out = String::new();
    match text(message, "role") {
        "toolResult" => {
            let id = text(message, "toolCallId");
            let mut body = String::new();
            if let Some(rendered) = custom_tool(data, id, "resultHtmlExpanded")
                .or_else(|| custom_tool(data, id, "resultHtmlCollapsed"))
            {
                body.push_str(&rendered);
            } else {
                content(&mut body, &message["content"], true, data);
            }
            let status = if message["isError"] == true {
                "Tool error"
            } else {
                "Tool result"
            };
            out.push_str(&details(
                &format!("{status} · {}", text(message, "toolName")),
                &body,
            ));
            if !message["details"].is_null() {
                out.push_str(&details("Result details", &json(&message["details"])));
            }
        }
        "bashExecution" => {
            let _ = write!(
                out,
                "<pre>$ {}</pre><pre>{}</pre>",
                escape_html(text(message, "command")),
                ansi_to_html(text(message, "output"))
            );
            if let Some(code) = message["exitCode"].as_i64() {
                let _ = write!(out, "<p>Exit status {code}</p>");
            }
        }
        "branchSummary" | "compactionSummary" => out.push_str(&markdown(text(message, "summary"))),
        _ => content(&mut out, &message["content"], false, data),
    }
    if let Some(error) = message["errorMessage"].as_str() {
        let _ = write!(out, "<p>Error: {}</p>", escape_html(error));
    }
    if !message["usage"].is_null() {
        out.push_str(&details("Model usage", &json(&message["usage"])));
    }
    out
}

fn role(entry: &Value) -> &str {
    if text(entry, "type") == "message" {
        text(&entry["message"], "role")
    } else {
        text(entry, "type")
    }
}

fn entry_body(entry: &Value, data: &SessionExportData) -> String {
    match text(entry, "type") {
        "message" => message_body(&entry["message"], data),
        "branch_summary" | "compaction" => markdown(text(entry, "summary")),
        "custom_message" if entry["display"] == true => {
            let mut out = String::new();
            content(&mut out, &entry["content"], false, data);
            out
        }
        _ => details("Entry details", &json(entry)),
    }
}

fn article(out: &mut String, entry: &Value, data: &SessionExportData, label: Option<&str>) {
    let id = escape_html(text(entry, "id"));
    let role = role(entry);
    let class = match role {
        "user" => "user",
        "assistant" => "assistant",
        "toolResult" => "toolResult",
        _ => "event",
    };
    let tagged = if label.is_some() { " labeled" } else { "" };
    let _ = write!(out, "<article id=\"entry-{id}\" class=\"{class}{tagged}\"><div class=\"byline\"><h2>{}</h2><time>{}</time>", escape_html(role), escape_html(text(entry, "timestamp")));
    if let Some(label) = label {
        let _ = write!(out, "<strong>{}</strong>", escape_html(label));
    }
    let message = &entry["message"];
    if let Some(model) = message["model"].as_str() {
        let _ = write!(out, "<span>{}</span>", escape_html(model));
    }
    let _ = writeln!(
        out,
        "<a href=\"#entry-{id}\" aria-label=\"Link to entry {id}\">#</a></div>{}</article>",
        entry_body(entry, data)
    );
}

pub(super) fn transcript(data: &SessionExportData) -> String {
    let mut out = String::from("<header><h1>Session Export</h1>");
    let _ = write!(
        out,
        "<p>{} · {} · {}</p>",
        escape_html(text(&data.header, "id")),
        escape_html(text(&data.header, "timestamp")),
        escape_html(text(&data.header, "cwd"))
    );
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    let mut children = vec![Vec::new(); data.entries.len()];
    let mut roots = Vec::new();
    let mut labels = HashMap::new();
    let mut tokens = 0_u64;
    let mut cost = 0.0;
    // Parents precede their children in the append-only session. Orphans stay visible as roots.
    for (index, entry) in data.entries.iter().enumerate() {
        if let Some(parent) = by_id.get(text(entry, "parentId")).copied() {
            children[parent].push(index);
        } else {
            roots.push(index);
        }
        if let Some(id) = entry["id"].as_str() {
            by_id.insert(id, index);
        }
        if text(entry, "type") == "label" {
            let target = text(entry, "targetId");
            if let Some(label) = entry["label"].as_str().filter(|s| !s.is_empty()) {
                labels.insert(target, label);
            } else {
                labels.remove(target);
            }
        }
        let usage = &entry["message"]["usage"];
        for key in ["input", "output", "cacheRead", "cacheWrite"] {
            tokens = tokens.saturating_add(usage[key].as_u64().unwrap_or(0));
        }
        cost += usage["cost"]["total"].as_f64().unwrap_or(0.0);
    }
    let _ = write!(
        out,
        "<p>{} entries · {tokens} tokens · ${cost:.4}</p>",
        data.entries.len()
    );
    if let Some(prompt) = &data.system_prompt {
        out.push_str(&details("System prompt", &markdown(prompt)));
    }
    if let Some(tools) = &data.tools {
        let mut body = String::new();
        for tool in tools {
            body.push_str(&details(text(tool, "name"), &json(tool)));
        }
        out.push_str(&details("Registered tools", &body));
    }
    let mut selected = HashSet::new();
    let mut cursor = data.leaf_id.as_deref();
    while let Some(index) = cursor.and_then(|id| by_id.get(id)).copied() {
        if !selected.insert(index) {
            break;
        }
        cursor = data.entries[index]["parentId"].as_str();
    }
    if let Some(leaf) = data.leaf_id.as_deref().filter(|id| by_id.contains_key(id)) {
        let _ = write!(
            out,
            "<nav><a href=\"#entry-{}\">Current leaf</a></nav>",
            escape_html(leaf)
        );
    }
    out.push_str("</header><div class=\"filters\"><label><input type=\"checkbox\" id=\"hide-tools\"> Hide tool results</label><label><input type=\"checkbox\" id=\"users\"> User messages</label><label><input type=\"checkbox\" id=\"labels\"> Labeled entries</label></div>");
    // A linear history uses no nested HTML. Only forks introduce disclosure elements.
    // Use a stack so arbitrarily deep sessions do not consume the Rust call stack.
    let mut stack: Vec<_> = roots
        .iter()
        .rev()
        .map(|&i| Some((i, roots.len() > 1)))
        .collect();
    while let Some(item) = stack.pop() {
        let Some((i, fork)) = item else {
            out.push_str("</details>");
            continue;
        };
        let entry = &data.entries[i];
        let id = text(entry, "id");
        if fork {
            let open = if selected.contains(&i) { " open" } else { "" };
            let title = labels.get(id).copied().unwrap_or(id);
            let _ = write!(
                out,
                "<details class=\"branch\"{open}><summary>Branch · {}</summary>",
                escape_html(title)
            );
            stack.push(None);
        }
        article(&mut out, entry, data, labels.get(id).copied());
        let siblings = &children[i];
        stack.extend(
            siblings
                .iter()
                .rev()
                .map(|&i| Some((i, siblings.len() > 1))),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn offline_tree_renders_each_turn_once_with_the_selected_fork_open() {
        let data = SessionExportData {
            header: json!({"id":"thread","cwd":"/work"}),
            leaf_id: Some("right".into()),
            system_prompt: Some("System instructions".into()),
            tools: Some(vec![json!({"name":"echo", "parameters":{}})]),
            rendered_tools: Some(json!({"call-1":{"callHtml":"<strong>Custom call</strong>",
                "resultHtmlExpanded":"<span onclick='unused'>Custom output</span>"}})),
            entries: vec![
                json!({"id":"root", "type":"message", "message":{"role":"user", "content":"**question**"}}),
                json!({"id":"left", "parentId":"root", "type":"message", "message":{"role":"assistant",
                    "content":[{"type":"thinking","thinking":"Planning"}, {"type":"toolCall","name":"echo","id":"call-1"}]}}),
                json!({"id":"right", "parentId":"root", "type":"message", "message":{"role":"toolResult", "toolCallId":"call-1","toolName":"echo"}}),
                json!({"id":"label", "parentId":"right", "type":"label","targetId":"left","label":"Earlier response"}),
            ],
        };
        let html = transcript(&data);
        assert_eq!(html.matches("<strong>question</strong>").count(), 1);
        for expected in [
            "class=\"branch\"><summary>Branch · Earlier response",
            "class=\"branch\" open><summary>Branch · right",
            "href=\"#entry-right\"",
            "System instructions",
            "Registered tools",
            "Thinking",
            "<strong>Custom call</strong>",
            "Custom output",
        ] {
            assert!(html.contains(expected), "{expected}");
        }
        assert!(!html.contains("onclick="));
    }

    #[test]
    fn markdown_keeps_code_and_escapes_inline_html() {
        let result =
            markdown("### Notes\n\nA <button>literal</button> tag.\n\n```rust\nfn main() {}\n```");
        assert!(result.contains("<h3>Notes</h3>"));
        assert!(result.contains("&lt;button&gt;literal&lt;/button&gt;"));
        assert!(result.contains("<span style="));
        assert!(!result.contains("<button>"));
    }
}
