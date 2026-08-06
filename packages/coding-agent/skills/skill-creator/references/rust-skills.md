# Rust Crate Skills

A Rust skill is a regular markdown skill that also ships a Rust crate. Prime
Agent mounts the crate into the session workspace as a member and re-exports
it as `agent_lib::skills::<crate_name>`, so rust cells call it directly
instead of shelling out. The crate is mounted in place (no copy): editing the
skill source takes effect on the next cell compile.

## Detection Contract

All of these must hold or the skill silently degrades to a markdown-only
skill (with a load warning):

- `SKILL.md` exists as usual.
- `Cargo.toml` exists at the skill root — its presence is what marks the skill as Rust-backed.
- The crate name is the skill name with hyphens converted to underscores.
- `src/lib.rs` exists.

For a skill named `word-count`, cells call `agent_lib::skills::word_count`.

## Minimal Template

```
word-count/
├── SKILL.md
├── Cargo.toml
└── src/
    └── lib.rs
```

**`SKILL.md`**

```markdown
---
name: word-count
description: Count word frequencies in text and return the most common words. Use when the user asks for word counts or frequency analysis of a text snippet.
---

# Word Count

Call from a rust cell:

    // Signature: word_count::run(text: &str, top: usize) -> String
    use agent_lib::skills::word_count;
    println!("{}", word_count::run("some text to analyze", 3));
```

**`Cargo.toml`**

```toml
[package]
name = "word_count"
version = "0.1.0"
edition = "2021"

[dependencies]
anyhow = { workspace = true }
```

**`src/lib.rs`**

```rust
use std::collections::HashMap;

/// Count words in `text` and return the `top` most common ones.
pub fn run(text: &str, top: usize) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word).or_default() += 1;
    }
    let mut entries: Vec<_> = counts.into_iter().collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    entries
        .into_iter()
        .take(top)
        .map(|(word, count)| format!("{word}: {count}"))
        .collect::<Vec<_>>()
        .join("\n")
}
```

## The Crate Contract

- The `[package] name` must be the skill name with `-` → `_`. The mount
  re-exports the crate under exactly that name.
- Compile target is `wasm32-wasip1` inside the WasmEdge sandbox: no network,
  no processes, filesystem limited to the session preopens (`/workspace`,
  `/state`, `/agent/lib`, `/scratch`). Host capabilities (web search, spawn,
  messaging) go through the `rlm` crate.
- Available workspace dependencies — declare with `{ workspace = true }`:
  `rlm`, `anyhow`, `regex`, `serde`, `serde_json`, `walkdir`. The dependency
  set is fixed (crates.io additions are not supported in this phase); build
  everything else from `std`.
- **Document every public signature in SKILL.md.** The mounted crate has no
  runtime introspection; SKILL.md is the API reference the model reads.
- Prefer `pub fn run(...) -> anyhow::Result<String>` (or `-> String`) as the
  main entry point, with additional named functions for variants.

## Host Requests

A skill that needs a host capability calls `rlm::host_request(type, payload)`.
Only request types the host registers will succeed; unknown types return a
host error. The bundled `websearch` skill is the reference example:

```rust
let reply = rlm::host_request("websearch.run", serde_json::json!({"query": query}))?;
```

## Quality Gate

Before installing a skill, prove it compiles and behaves:

1. Write `#[cfg(test)]` unit tests for the pure logic in `src/lib.rs`.
2. Mount the skill (start a session or `/reload`) and exercise it from a rust
   cell — the first cell after a mount compiles the skill; compiler errors
   surface in the cell result.
3. A skill that fails to compile is unmounted with a warning diagnostic and
   its crate is unavailable until fixed; the rest of the workspace keeps
   working.

## Verifying a Rust Skill

1. Check the contract: crate name matches the skill name (`-` → `_`),
   `src/lib.rs` exists, every public signature is documented in SKILL.md.
2. In a fresh agent session (or after `/reload`), confirm the skill appears
   in the system prompt's `<available_skills>` with `<type>rust</type>` and
   that `agent_lib::skills::<crate_name>::run(...)` compiles in a cell.
3. Loading problems (bad name, missing lib.rs, compile failure) surface as
   warning diagnostics.
