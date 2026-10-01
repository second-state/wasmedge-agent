# Rust Crate Skills

A Rust skill is a regular markdown skill that also ships a Rust crate. WasmEdge
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

## Scaffolding from a Cell

For a new project-local skill, call:

```rust
let skill = rlm::skills::package(name, description, instructions, source)?;
println!("{}: {}", skill.path, skill.rust_use);
```

Signature: `package(name: &str, description: &str, instructions: &str, source: &str)
-> Result<rlm::skills::PackagedSkill>`. The reply contains `path` (an absolute guest
path), `crate_name`, `rust_use`, and `requires_reload` (always true).

The host creates `SKILL.md`, a manifest inheriting the fixed workspace dependencies,
and `src/lib.rs` under the project's config directory. Pass complete library source
including deterministic unit tests; put every public signature and usage instructions
in `instructions`. Names must start with a lowercase letter and follow the frontmatter
rules; reserved Rust/workspace crate names are rejected. Description, instructions
and source are limited to 1024, 65536 and 262144 characters respectively.

The operation rejects loaded-name collisions, existing destinations and symlinked
parent directories. It only creates files: reload with `/reload` (or start a new
session) to mount them, then use the Quality Gate below to register the skill.
It does not add crates, create global skills, overwrite existing skills or certify
the supplied source. Existing skills can still be edited through their project files.

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

#[cfg(test)]
mod tests {
    use super::run;

    #[test]
    fn counts_and_breaks_ties_alphabetically() {
        assert_eq!(run("pear apple pear banana apple", 3), "apple: 2\npear: 2\nbanana: 1");
        assert_eq!(run("", 3), "");
        assert_eq!(run("apple", 0), "");
    }
}
```

## The Crate Contract

- The `[package] name` must be the skill name with `-` → `_`. The mount
  re-exports the crate under exactly that name.
- Compile target is `wasm32-wasip1`, executed by WasmEdge. Cells cannot spawn
  native processes; filesystem access is limited to preopens (`/workspace`,
  `/agent/state`, `/agent/lib`, and `/scratch`). Host APIs
  (web search, spawn, messaging) go through `rlm` over private stdio pipes.
  The runner rejects socket/DNS and plugin imports before executing cells,
  even if unused; direct guest network calls are unavailable.
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

Before registering a Rust skill through `/refine` or `rlm::harness`:

1. Write deterministic `#[cfg(test)]` unit tests in `src/lib.rs` and, if
   needed, integration tests in `tests/`. Use the standard Rust test harness.
2. Mount the crate by starting a session or running `/reload`. A crate that
   fails the mount's compile check is unmounted with a diagnostic; fix it and
   reload before registration.
3. `/refine` automatically builds the mounted crate's unit and integration
   tests with `cargo test --release --offline --target wasm32-wasip1 --no-run
   --lib --tests`, then executes the WASI test modules in WasmEdge. It accepts
   create/update only when every module succeeds and at least one non-ignored
   test passes. Failures are included in the refinement result; a failed update
   preserves the prior harness entry. Guest `create_skill`, `update_skill`,
   and `update("skill", ...)` call the same test runner through the bridge and
   propagate failures without saving the entry. SDK `refineHarness` callers
   must supply a sandboxed skill validator or skill create/update edits are rejected.

Tests run against a disposable copy of the workspace, with only `/scratch`
preopened. Project files, session state, harness stores, and the host bridge
are unavailable: test pure logic and use fixtures written under `/scratch`.
Before running any tests, the host validates all compiled modules and checks
imports against a fixed set of non-network WASI Preview 1 functions. Socket/DNS
calls, plugin APIs, unknown imports, and non-function imports reject registration,
even when unused. Keep tests independent of network and bridge calls; test pure
logic with local fixtures. The host JavaScript engine only validates and inspects
modules without instantiating them; unsupported Wasm features also fail closed.
WasmEdge runs tests with `--force-interpreter` to ignore embedded AOT native code.
Doctests are excluded. Do not execute model-written tests natively on the host.
Each crate uses the configured `rustCell.cellTimeoutMs` budget for queueing,
building, and execution; cancellation prevents applying the proposal. Guest
requests additionally share the calling cell's remaining budget, and closing
the bridge or ending the cell cancels its in-flight test.

This checks the source snapshot at registration time. Editing the mounted
source later does not automatically retest it. Ordinary cell/library edits
and host-side manual harness file edits do not pass through this gate. Guest
harness CRUD requires the host bridge; harness stores are not preopened, and
writable mount roots must be separate from those stores. Passing tests does
not establish coverage or task correctness.
Cargo build scripts/proc macros retain the existing host trust boundary.
Ordinary cells share the test import policy and interpreter requirement but
have a stdio bridge for registered host capabilities.

## Verifying a Rust Skill

1. Check the contract: crate name matches the skill name (`-` → `_`),
   `src/lib.rs` exists, every public signature is documented in SKILL.md.
2. In a fresh agent session (or after `/reload`), confirm the skill appears
   in the system prompt's `<available_skills>` with `<type>rust</type>` and
   that `agent_lib::skills::<crate_name>::run(...)` compiles in a cell.
3. Loading problems (bad name, missing lib.rs, compile failure) surface as
   warning diagnostics.
