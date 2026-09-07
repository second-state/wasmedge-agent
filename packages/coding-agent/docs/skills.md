> WasmEdge Agent can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that WasmEdge Agent loads on demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

WasmEdge Agent implements the [Agent Skills standard](https://agentskills.io/specification), warning about violations but remaining lenient. It also supports Rust crate skills: a superset of markdown skills that mount a crate into the cell workspace and expose it as typed calls under `agent_lib::skills`.

## Table of Contents

- [Locations](#locations)
- [Built-in Skills](#built-in-skills)
- [How Skills Work](#how-skills-work)
- [Rust Crate Skills](#rust-crate-skills)
- [Creating Skills with WasmEdge Agent](#creating-skills-with-wasmedge-agent)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

WasmEdge Agent loads skills from:

- Global:
  - `~/.wasmedge-agent/skills/`
  - `~/.agents/skills/`
- Project:
  - `.wasmedge-agent/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)
- Built-in: `skills/` shipped with the wasmedge-agent package (lowest precedence)

Discovery rules:
- In `~/.wasmedge-agent/skills/` and `.wasmedge-agent/skills/`, direct root `.md` files are discovered as individual skills
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

## Built-in Skills

WasmEdge Agent ships with built-in skills that load by default:

- `skill-creator` - teaches the agent to create new skills: markdown skill layout, frontmatter rules, placement and precedence, and the full Rust crate skill contract (crate layout, `run()` convention, workspace-dependency rules) with a working template in `references/rust-skills.md`.
- `websearch` - a Rust crate Google search skill using the [Serper](https://serper.dev) API; the crate calls a typed host request, so the API key never enters the sandbox.

Built-in skills behave like any other skill but have the lowest precedence: a user, project, package, or `--skill` skill with the same name overrides the built-in one.

### websearch

Setup: get a free API key at [serper.dev](https://serper.dev), then run `/login`,
switch to **MCP Connections** using the displayed tab shortcuts, and choose
**Serper (web search)** to paste it. The key is stored alongside your other
credentials (in `auth.json`) and read by the skill on each call — no environment
variables required, and it works even if you add the key mid-session.

Optional overrides (environment variables):

```bash
export WASMEDGE_AGENT_WEBSEARCH_TIMEOUT=45
export WASMEDGE_AGENT_WEBSEARCH_NUM_RESULTS=5
```

A `SERPER_API_KEY` in the environment, if set, takes precedence over the stored key.

Once mounted, the model calls it from a rust cell:

```rust
let results = agent_lib::skills::websearch::run("latest WasmEdge Agent release")?;
println!("{results}");
```

Until a key is configured, web search returns a clear message telling the agent
to walk you through `/login`.

Disable only the built-in `websearch` skill in settings:

```json
{
  "bundledSkills": {
    "websearch": false
  }
}
```

To disable all built-in skills, set `enableBuiltinSkills` to `false` in `settings.json` (or toggle "Built-in skills" in `/settings`):

```json
{
  "enableBuiltinSkills": false
}
```

`--no-skills` also excludes built-in skills. To disable a single built-in skill without a dedicated setting, force-exclude it in the global `skills` array (patterns resolve against the built-in skills directory):

```json
{
  "skills": ["-websearch/SKILL.md"]
}
```

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.wasmedge-agent/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, WasmEdge Agent scans skill locations and extracts names, descriptions, type, and file locations
2. The system prompt includes visible skills in XML format per the [specification](https://agentskills.io/integrate-skills); Rust skills additionally list their `agent_lib::skills` use path
3. When a task matches, the agent reads the full `SKILL.md` from a rust cell (models don't always do this; use prompting or `/skill:name` to force it)
4. The agent follows the instructions — calling the mounted crate for a Rust skill, or using relative paths to reference scripts and assets for a markdown skill

This is progressive disclosure: only descriptions are always in context, full instructions load on-demand.

Skills with `disable-model-invocation: true` are hidden from the startup skill list. They can still be invoked explicitly with `/skill:name`.

## Rust Crate Skills

A Rust crate skill uses the same `SKILL.md` metadata and invocation behavior as a markdown skill, but also provides a crate that WasmEdge Agent mounts into the cell workspace.

```
web-search/
├── SKILL.md
├── Cargo.toml
└── src/
    └── lib.rs
```

Detection rules:
- `SKILL.md` is still required
- `Cargo.toml` marks the skill as a Rust crate skill
- the crate name is the skill name with hyphens converted to underscores
- `src/lib.rs` must exist

For `web-search`, WasmEdge Agent exposes `agent_lib::skills::web_search` in cells. The convention is a documented `run()` entry point, with any richer typed API alongside it:

```rust
use agent_lib::skills::web_search;

let summary = web_search::run("prime agent skills")?;
```

At session start (and on `/reload`) the skill directory is linked into the workspace as `skills/<crate>` and added to the cargo workspace, so edits to the skill source take effect on the next cell compile — there is no install step. When the mounted set or a manifest changes, each skill gets a probe build; a skill that fails to compile is unmounted with a diagnostic while every other skill and cells keep working.

Dependencies must come from the workspace's locked set — declare them with `{ workspace = true }` (`anyhow`, `serde`, `serde_json`, `regex`, `walkdir`, and the `rlm` bridge crate). The template's dependency sources are vendored for hermetic builds, so a crates-io dependency outside that set fails the probe build; capabilities that need the network go through a typed host request instead (the `websearch` crate is the reference example). A legacy `pyproject.toml` skill still loads as a markdown skill, with a diagnostic explaining that its Python package is ignored.

## Creating Skills with WasmEdge Agent

WasmEdge Agent ships with a built-in `skill-creator` skill that teaches the agent both the Agent Skills format and the Rust crate contract. You can ask for a skill in normal language:

```text
Create a project Rust crate skill named release-audit in
.wasmedge-agent/skills/release-audit. It should expose
agent_lib::skills::release_audit::run(repository, target_version), include
concise SKILL.md instructions, use workspace dependencies, and verify the
call compiles and runs in a cell.
```

To force the creation workflow explicitly, invoke the built-in skill command:

```text
/skill:skill-creator Create a personal markdown skill for reviewing database migrations.
```

Tell the agent three things:

1. **Scope:** use `.wasmedge-agent/skills/<name>/` for a project skill committed with the repository, or `~/.wasmedge-agent/skills/<name>/` for a personal skill.
2. **Kind:** ask for a markdown skill when the capability is primarily instructions; ask for a Rust crate skill when the agent should call reusable functionality from cells.
3. **Contract:** describe the intended Rust call, inputs, output, dependencies, credentials, and verification behavior.

The agent should create `SKILL.md` in both cases. For a Rust crate skill it should also create `Cargo.toml` and `src/lib.rs`, expose a documented `run()` callable, and verify the crate compiles and answers from a cell.

Use `/reload` to rediscover new or edited skill metadata and remount the workspace; source edits to an already-mounted crate need no reload at all — the symlink means the next cell compile picks them up.

### Installed Skills and Continual Harness Skills

An installed Rust crate skill is real code on disk that adds executable functionality to cells. A continual harness skill entry is a persisted description of a reusable call, including its `{"type": "rust", "use": ...}` reference and argument contract. `/refine` (and `rlm::harness`) can create or update the latter after a repeated procedure emerges, but it does not replace packaging new functionality with `skill-creator`.

## Skill Commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command are appended to the skill content as `User: <args>`.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Must match parent directory. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
- Must match parent directory name

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

WasmEdge Agent validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name doesn't match parent directory
- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription
