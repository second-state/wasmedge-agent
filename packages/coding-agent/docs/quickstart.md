# Quickstart

This page gets you from install to a useful first WasmEdge Agent session.

## Install

> Installation arrives with the first WasmEdge Agent release. Until then,
> build from source: see [development.md](development.md).

To run a source checkout, use Node.js 22.8.0 or newer:

```bash
git clone https://github.com/hydai/wasmedge-agent
cd wasmedge-agent
npm ci
./wasmedge-agent.sh
```

The source runner preserves the directory from which it is invoked, so you can also call `/path/to/wasmedge-agent/wasmedge-agent.sh` from another project.

The release will install the `wasmedge-agent` command; the inherited npm workspace identifiers in the source tree are not the public install path. Once it is installed, start WasmEdge Agent in the project directory you want it to work on:

```bash
cd /path/to/project
wasmedge-agent
```

## Authenticate

WasmEdge Agent can use subscription providers through `/login`, or API-key providers through environment variables or its auth file.

### Option 1: Subscription Login

Start WasmEdge Agent and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API Key

Set an API key before launching WasmEdge Agent:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
wasmedge-agent
```

You can also run `/login` and select an API-key provider to store the key in `~/.wasmedge-agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First Session

Once WasmEdge Agent starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

WasmEdge Agent gives the model two built-in tools: `rust` and `bash`. The `rust` tool compiles each cell to WebAssembly and runs it in a WasmEdge sandbox — that is where the model reads and edits files, inspects data, persists state between cells, and invokes installed skills; `bash` runs a project's own commands. The cell runtime needs `cargo` with the `wasm32-wasip1` target and a `wasmedge` binary: the installer offers to set both up, the workspace template is prebuilt automatically on first use, and `doctor` / `doctor --fix` report and repair the toolchain. Set `WASMEDGE_AGENT_CARGO` or `WASMEDGE_AGENT_WASMEDGE` to use specific binaries.

WasmEdge Agent runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Recursive Subagents

Recursive subagents are a built-in WasmEdge Agent capability. The model spawns independent work from a rust cell with `rlm::spawn("subtask")?`; each call returns at admission with a child handle and never returns the answer. Children send requested results as explicit agent-message replies to the parent (`rlm::msg::send_to_parent`) or write them to files. Child agents use the same TypeScript agent runtime, providers, tools, skills, and session machinery as the parent.

You can prompt the model to use that capability directly:

```text
Review authentication and test coverage as independent subtasks. Run them in parallel, then synthesize the findings.
```

See [RLM Runtime Architecture](rlm-runtime.md) for the API and execution model.

## Give WasmEdge Agent Project Instructions

WasmEdge Agent loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

WasmEdge Agent loads:

- `~/.wasmedge-agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart WasmEdge Agent, or run `/reload`, after changing context files.

## Common Things to Try

### Reference Files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
wasmedge-agent @README.md "Summarize this"
wasmedge-agent @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with Ctrl+V (Alt+V on Windows) or dragged into supported terminals.

### Run Shell Commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to model context. During agent work, the model runs project commands through its `bash` tool, while file work and data transformation happen in rust cells.

### Switch Models

Use `/model` or Ctrl+L to choose a model. Use `/effort` to set the reasoning level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue Later

Sessions are saved automatically under `~/.wasmedge-agent/sessions/`:

```bash
wasmedge-agent -c                  # Continue the most recent session
wasmedge-agent -r [path|id]        # Browse sessions or open a specific session
```

Inside WasmEdge Agent, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions. Persistent sessions run in worker processes, so closing the TUI detaches from the agent rather than necessarily stopping it. Use `wasmedge-agent agents` to inspect or reattach to active work.

### Non-Interactive Mode

For one-shot prompts:

```bash
wasmedge-agent -p "Summarize this codebase"
cat README.md | wasmedge-agent -p "Summarize this text"
wasmedge-agent -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next Steps

- [Using WasmEdge Agent](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [WasmEdge Agent Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
