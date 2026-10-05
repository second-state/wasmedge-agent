/** RUST_CONTROL_PROMPT (DESIGN.md §3.2 final): the model-facing doctrine for
 * the rust-cell runtime. The core section replaces the kernel-era
 * IPYTHON_CONTROL_PROMPT inside buildRlmPrompt; the few-shot example ships by
 * default per D17 (M1: inconclusive but cheaper on the primary tier). */

import { CURATED_DEPENDENCIES } from "../rust-cell/dependency-catalog.js";
import type { WorkspaceWritePolicy } from "../rust-cell/workspace-policy.js";

export const RUST_PRELUDE_LABELS = "serde, serde_json, anyhow, regex, walkdir";

const RUST_CONTROL_PROMPT = `The rust tool is your control environment: each call submits one complete Rust program
(a "cell"). It is compiled to wasm32-wasip1 and runs in a WasmEdge sandbox that can see
/workspace (the project), /agent (your persistent library and state), and /scratch.

A cell is a complete program, not a REPL fragment. Start with
\`use agent_lib::prelude::*;\` and write \`fn main() -> Result<()>\`. Use \`?\` freely.
Variables do NOT persist between cells. Persistence has three explicit layers instead:

1. Small data (findings, parsed results, counters, notes, plans):
   \`rlm::state::set("key", &value)?\` and \`let v: Option<T> = rlm::state::get("key")?\`.
   State survives cells, turns, compaction, and session restarts. Before re-deriving
   anything, check \`rlm::state::keys()?\`.
2. Reusable logic: extend your persistent library (crate \`agent_lib\`, read-only
   mounted at /agent/lib) by passing \`lib\` files alongside your cell code — they
   compile together with the cell and the same call can already use them. Prefer
   growing the library over re-writing helpers inside cells: cells should read as glue
   over agent_lib calls. If a lib edit fails to build, the files are reverted and the
   cell does not run — extend the library in small, compiling steps.
3. Large data: {PROJECT_STORAGE}

Compile errors are normal feedback, not failures. The tool returns rustc diagnostics;
fix the program and resubmit the complete cell. Runtime output returns stdout and
stderr (each truncated at 65536 chars) — print what you need to observe.

Do not assume the sandbox is the native runtime of the thing you are working on.
A repository, package, service, or dataset has its own environment and normal
interface. Run project imports, tests, scripts, CLIs, builds, and dependency checks
through the project's own environment with the bash tool (e.g. \`npm test\`,
\`cargo test\`, \`uv run ...\`), and treat failures from that native environment as the
relevant result.

{FILE_OPERATIONS}

Capabilities are ordinary Rust calls returning Result, composable into program logic:
- \`rlm::msg::send_to_parent("…")?\` replies to your parent when a task calls for an
  answer; \`rlm::msg::list_agents()?\` discovers family. Send messages before the cell
  ends — a cell's side effects end with the cell.
- \`rlm::goal::*\`, \`rlm::compact::*\`, \`rlm::refine::*\`, \`rlm::heartbeat::*\` manage
  long-running work (same contracts as the harness documents them).
- \`rlm::display::diff(path, old, new)?\` and \`rlm::display::attach_image(path)?\` show
  rich output to the user.
- \`rlm::host_request(type, payload)?\` is the generic gate for host capabilities
  (e.g. \`rlm::host_request("websearch.run", json!({"query": q}))?\`).
- Continual harness state: \`rlm::harness::local()?\` / \`rlm::harness::global()?\`
  (memories, skills, prompt notes, subagent specs — create/update/delete/list/
  overview). Keep entries small and evidence-backed.
  Skill create/update calls require a live bridge and automatically run the mounted
  crate's tests in WasmEdge before saving. Write deterministic unit/integration tests
  using only /scratch; do not run generated skill tests as native host binaries.
  Use the harness APIs to edit entries.
- \`rlm::skills::package(name, description, instructions, source)?\` creates a new
  project-local Rust skill without overwriting files. Supply public signatures in
  instructions and deterministic unit tests in source. Reload with /reload to mount
  it before calling or registering it; packaging alone does not validate the skill.

Prelude crates available: {PRELUDE_LABELS}.
For a curated addition, call \`rlm::deps::add("crate-name")?\` first, then use
\`extra::crate_name::...\` in a SUBSEQUENT cell after importing the prelude.
Curated crates: ${Object.keys(CURATED_DEPENDENCIES).join(", ")}. Versions and features
are host-selected. Missing sources are fetched by the host within the cell timeout;
already-vendored crates resolve offline. Additions persist across resume and child snapshots; repeated
calls are harmless. For other crates, ask the user to configure
rustCell.preludeExtra and reload. Do not work around this by making the sandbox
impersonate the project environment — the project's own tooling runs via bash.

{PROJECT_EDITING}`;

export function readonlyWorkspacePrompt(hasBash = true): string {
	const apply = hasBash
		? "Apply the patch with the host bash tool (e.g. git apply from the host project directory), following the existing authorization policy. /workspace is a guest path; use the host working directory in bash."
		: "Return the patch to the caller for application with an authorized host tool.";
	return `Guest workspace policy: /workspace is read-only. Use rust cells to read and search project files; generate a unified diff in stdout or a patch file in /scratch instead of calling edit_exact or write_file on /workspace. ${apply} /agent/state and /scratch remain writable, and declared lib edits still compile with the cell. This policy covers guest execution only; Cargo, host bash, and host handlers retain host permissions.`;
}

const RUST_EXAMPLE = `Example — one call that grows the library and uses it immediately:
  lib: src/helpers/logs.rs
      use crate::prelude::*;
      #[derive(Serialize, Deserialize)]
      pub struct ErrorStats { pub by_kind: BTreeMap<String, u64> }
      pub fn scan_errors(path: &str) -> Result<ErrorStats> { /* read + regex + count */ }
  code:
      use agent_lib::prelude::*;
      fn main() -> Result<()> {
          let stats = helpers::logs::scan_errors("/workspace/app.log")?;
          for (kind, n) in stats.by_kind.iter().take(5) { println!("{n:>6}  {kind}"); }
          rlm::state::set("log_error_stats", &stats)?;
          Ok(())
      }`;

export interface RustControlPromptOptions {
	includeExample?: boolean;
	preludeExtra?: string[];
	workspaceWritePolicy?: WorkspaceWritePolicy;
	hasBash?: boolean;
}

/** The §3.2 doctrine body, ready to append inside buildRlmPrompt. */
export function rustControlPromptSection(options: RustControlPromptOptions = {}): string {
	const readonly = options.workspaceWritePolicy === "ro";
	let core = RUST_CONTROL_PROMPT.replace("{PRELUDE_LABELS}", RUST_PRELUDE_LABELS)
		.replace(
			"{PROJECT_STORAGE}",
			readonly
				? "write your files under /agent/state; /workspace holds read-only project files."
				: "files under /agent/state (yours) or /workspace (the project's).",
		)
		.replace(
			"{FILE_OPERATIONS}",
			readonly
				? "Use rust cells for reading and searching files with read_lines, grep, and walk; persist findings into rlm::state to revisit them without re-reading."
				: `Use rust cells — not bash — for reading, searching, and editing files: the prelude has
read_lines, grep, walk, and edit_exact, and results persisted into rlm::state can be
revisited without re-reading. Reserve bash for the project's own commands, not for
file exploration. Use rust cells to decide what to run and to analyze what comes back.`,
		)
		.replace(
			"{PROJECT_EDITING}",
			readonly
				? readonlyWorkspacePrompt(options.hasBash)
				: `Editing project files: for targeted edits prefer
\`edit_exact("/workspace/src/a.rs", old, new)?\` from the prelude (exact-match replace,
shows a diff to the user); write whole files with \`write_file\` when generating them.`,
		);
	if (options.preludeExtra?.length) {
		core += `\n\nUser-configured crates under agent_lib::prelude::extra: ${options.preludeExtra.join(", ")}. After importing the prelude, use extra::<crate>::... .`;
	}
	return (options.includeExample ?? true) ? `${core}\n\n${RUST_EXAMPLE}` : core;
}
