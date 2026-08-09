# Showcase: a guided first session

This is a hands-on tour of wasmedge-agent — a fork of Prime Agent where the
model iterates in **Rust cells** executed in a **WasmEdge** sandbox instead
of a persistent IPython kernel (see the [root README](../../README.md) for
the full comparison). You will install the toolchain, open the agent on a
small ops-style project, and run five short missions. Each mission
demonstrates one thing the runtime swap changes. Plan for 30–45 minutes.

## 1. Prerequisites

- Node.js ≥ 22.8 and npm
- Rust via [rustup](https://rustup.rs), plus the wasm target:
  `rustup target add wasm32-wasip1`
- [WasmEdge](https://wasmedge.org): `curl -fsSL https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install_v2.sh | bash`
  (this is what our own `install.sh` runs; the older `utils/install.sh`
  needs git and Python)
- Clone this repo, then from its root: `npm install && npm run build`

Verify everything:

```bash
./prime-agent.sh doctor        # six checks; `doctor --fix` repairs most issues
```

On a fresh clone, `doctor` will report the workspace template as
not-vendored and cold — that is expected. Run `./prime-agent.sh doctor
--fix` once (it takes a minute) to vendor and warm it, or let the first
launch do it lazily.

`npm run build` copies a second template into `dist/` with the vendored
dependencies and build cache stripped out, and that is the one `--dist`
uses. If you plan to launch with `--dist` in section 3, warm it too —
otherwise its first `rust` cell pays the one-time vendor and build itself:

```bash
./prime-agent.sh --dist doctor --fix
```

Unlike the source template, this one is not warmed once and left alone:
every `npm run build` re-copies it and strips `vendor/` and `target/` out
again. Re-run the command above after each rebuild, or the next `--dist`
session pays the vendor and build again on its first `rust` cell — and
fails outright if you happen to be offline.

## 2. Model access

The agent needs a capable model. Either export an API key that is
auto-discovered (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, …) or describe a custom endpoint in
`~/.prime/agent/models.json`:

```json
{
	"providers": {
		"my-provider": {
			"baseUrl": "https://api.example.com",
			"api": "anthropic-messages",
			"apiKey": "MY_PROVIDER_KEY_ENV_VAR",
			"models": [
				{
					"id": "my-model-id",
					"name": "My Model",
					"reasoning": true,
					"input": ["text"],
					"contextWindow": 200000,
					"maxTokens": 32000
				}
			]
		}
	}
}
```

`apiKey` names an environment variable holding the key — export it in the
shell you launch from (`export MY_PROVIDER_KEY_ENV_VAR=...`). If that
variable is unset, the name itself is sent as the credential and every
message fails with a 401. `api` can also be `openai-completions` for
OpenAI-style endpoints. Pick the model in the TUI with `/model` (or
Ctrl+L); your choice is saved as the default.

## 3. Launch

Copy the fixture somewhere writable — the agent mounts its working
directory at `/workspace` inside every cell, and missions write report
files there:

```bash
[ -d /tmp/showcase ] || cp -R examples/showcase/project /tmp/showcase
./prime-agent.sh --cwd /tmp/showcase --name showcase
```

`--name showcase` is what the cleanup step in section 4 uses to find this
agent again; without it the session gets an auto-assigned name and nothing
in `list` says which agent is the one rooted here.

The copy is guarded because missions 1 and 4 write their reports into that
directory and missions 2 and 5 send you back to it with `--continue` — so
re-running this snippet on a later visit keeps your earlier work. To start
over from the pristine fixture instead, delete it first with `rm -rf
/tmp/showcase`.

The TUI takes a few seconds to appear when running from source
(`./prime-agent.sh --dist` is ~3× faster after `npm run build`, once its
own template is warm — see section 1). Skim
`notes.md` in the fixture for the backstory: ops handed you a flaky
morning of API traffic and an inventory snapshot.

A note on how this runtime works, so the missions make sense: every `rust`
tool call the model makes is a **complete Rust program** — it is compiled
to `wasm32-wasip1` and executed in a WasmEdge sandbox that can only see
`/workspace` (your copied project) plus the runtime's own state mounts.
Compile errors are not failures; they are the feedback loop. When one
happens you will see the model read the rustc diagnostic and immediately
ship a corrected cell.

The agent also keeps a `bash` tool, and that one is **not** sandboxed — it
runs on the host with your own permissions and reach. The missions below
only exercise the `rust` path, but keep the distinction in mind when you
later point the agent at a real project.

## 4. The five missions

Paste each prompt as-is. The collapsed `rust` tool line already shows the
compile/run timings; press Ctrl+O ("Toggle tool output") to expand it and
read the cell source, its full output, and any rustc diagnostics.

### Mission 1 — first cell, sandboxed file I/O

> Parse /workspace/logs/access.log. Give me the status-code distribution
> and per-endpoint request counts, and write a short findings report to
> /workspace/report.md. Count a line only if every field parses, including
> the timestamp. Call out any endpoint that stands out.

**Watch for:** one cell containing a full `fn main()` program; absolute
`/workspace/...` paths (the sandbox has no working directory); the
compile+run timing line (warm builds are sub-second).

**Expected outcome:** 285 well-formed requests across 8 endpoints; status
totals 200×262, 301×2, 404×8, 500×11, 503×2; `/api/orders` flagged as the
problem child (9 of the 11 500s). `report.md` appears in `/tmp/showcase/`
on your host — the sandbox mount is your copied project directory. The
model may also mention lines it could not parse; that is mission 3.

### Mission 2 — explicit persistent state

> Compute per-endpoint latency stats (request count and median latency)
> from /workspace/logs/access.log and store them in your persistent rlm
> state under the key "endpoint_stats". Count a line only if every field
> parses, including the timestamp. Confirm what you stored.

Then, **as a separate follow-up message**:

> Without re-reading the log, load "endpoint_stats" from your rlm state
> and tell me the top 3 slowest endpoints by median latency.

**Watch for:** the second cell contains no log-parsing code — it reads the
state layer. Unlike a Python kernel's invisible in-memory namespace, this
state is explicit and on disk: it outlives the cell, the turn, and the
process, and you can ask the model "what keys are in your rlm state?". It
is scoped to the session, though — if you stop here and come back later,
reopen it with `./prime-agent.sh --cwd /tmp/showcase --continue`. Keep the
`--cwd`: `--continue` only considers sessions rooted at the directory you
launch from, so dropping it reattaches whatever session was last rooted
there — your own earlier work if you have used the agent in this repo, or
a fresh clean workspace clone if you have not. Never the showcase one.

**Expected outcome:** top 3 by median, in this order: `/api/reports`
(335 ms), `/api/inventory` (≈222 ms), `/api/orders` (≈207 ms). Those last
two have an even sample count straddling two values (221/224 and 207/208),
so the exact figure moves by a millisecond or two depending on which
median convention the model picks — the ordering is the stable part.

### Mission 3 — rustc as the feedback loop

> Some lines in /workspace/logs/access.log are corrupted in different ways —
> some are truncated outright, some have a garbled timestamp, some have a
> garbled latency value. Count how many of each kind, show one example line
> of each, and confirm how many well-formed lines remain — a line is
> well-formed only if every field parses, including the timestamp.

**Watch for:** this parsing is fiddly (three distinct corruption kinds), so
there is a fair chance a cell fails to compile or misclassifies on the
first try. Expand the failed cell: the rustc diagnostic goes straight back
to the model as tool output, and the next cell fixes it. One or two
iterations is normal operation, not an error.

**Expected outcome:** 15 corrupted lines — 5 truncated, 5 with a garbage
timestamp, 5 with a non-numeric latency field — and 285 well-formed lines.
The log ends with a trailing newline, so a cell that splits on `'\n'`
rather than using Rust's `.lines()` sees one extra empty entry and reports
16 corrupted lines with a blank example. Which bucket the blank lands in
depends on what that cell tests first — truncated if it counts fields,
garbled timestamp if it parses the timestamp — so either count is the same
parser artifact, not a runtime fault. Worth pointing out to the model.

### Mission 4 — recursive subagents

> Spawn a subagent to analyze /workspace/data/inventory.csv — the three
> lowest-stock SKUs and the total inventory value per warehouse, rounded
> to cents — and have it report its findings back to you. Meanwhile,
> summarize the 5xx error pattern in /workspace/logs/access.log yourself,
> counting a line only if every field parses, including the timestamp.

Spawning returns as soon as the child is *admitted*, so the parent ends
its turn without the answer. Once the child's report has arrived in the
transcript, **as a separate follow-up message**:

> Merge the subagent's inventory findings with your own 5xx summary into
> /workspace/briefing.md.

**Watch for:** the parent cell gets back only a handle — child id, name,
session directory, model — and does not block on the child. The child is a
full agent session with its own sandbox and its own fresh `rlm` state; it
delivers its answer with `rlm::msg::send_to_parent`, which surfaces as an
ordinary message in your transcript a turn later. Expand both transcripts.

**Expected outcome:** lowest stock: SKU-1900 (qty 2), SKU-1901 (qty 3),
SKU-1902 (qty 4); warehouse value leader FRA at ≈$759,740.37 (ATL
≈$338,692.05, SGP ≈$261,668.25); the 5xx summary again points at
`/api/orders`; `briefing.md` lands in `/tmp/showcase/`.

### Mission 5 (optional) — grow your agent_lib

> You have now parsed this log format several times. Promote a reusable
> parser into your agent_lib — say, a function that returns structured
> entries from a path, counting a line only if every field parses
> (including the timestamp) — then prove it works by calling it from a
> fresh cell that just prints the total request count.

**Watch for:** a declared lib edit (the runtime rebuilds `agent_lib` and
rolls back automatically if it does not compile), then a follow-up cell
whose source is two lines because the logic now lives in the library. This
is the fork's answer to a kernel's accumulated session state: a growable,
*compiled* standard library that persists across cells, turns, and
processes. Like the rlm state in mission 2 it lives in the session's
workspace, so come back with `--cwd /tmp/showcase --continue` to keep it;
a fresh session starts from the pristine template with an empty
`agent_lib`.

**Expected outcome:** the fresh cell reports 285 requests via the new
helper.

### When you are done

Closing the TUI detaches the client but leaves the background worker
running — it keeps `/tmp/showcase` open as its root and holds your provider
credentials until you stop it. Stop it by the name you launched it with —
`list` shows every agent on the machine and none of its columns say which one
is rooted here, so the name is what makes this one addressable:

```bash
./prime-agent.sh stop showcase
```

That releases the worker. The background supervisor stays up with a copy of
the environment you launched from, ready for the next agent;
`./prime-agent.sh shutdown` is what ends that too, but it stops **every**
agent and background service on your machine, interrupting any work in
flight — reach for it only when this showcase session is the only thing
running.

## 5. Troubleshooting

- `./prime-agent.sh doctor` (add `--fix` to repair) checks cargo, the wasm
  target, WasmEdge, and the workspace template.
- Launch hangs then reports a held socket lock → a previous daemon wedged:
  run `./prime-agent.sh shutdown --force` and retry (the error message
  says exactly this). `--force` skips the confirmation prompt, and the
  scope is still every agent on the machine — stop other sessions you care
  about before reaching for it.
- Cells must use absolute `/workspace/...` paths; WASI has no working
  directory, so relative paths fail with `os error 44`.
- Model errors on every message → provider/key problem; re-check §2. A 401
  usually means the environment variable named by `apiKey` was never
  exported into the shell you launched from.

## 6. Where next

- [Root README](../../README.md) — what the fork changes and why
- [`DESIGN.md`](../../DESIGN.md) — decisions D1–D25
- [`docs/m1-measurement-report.md`](../../docs/m1-measurement-report.md) and
  [`docs/m5-acceptance-report.md`](../../docs/m5-acceptance-report.md) —
  the measurements behind the runtime swap (both written in Traditional
  Chinese; the root README summarises the m1 numbers in English)
