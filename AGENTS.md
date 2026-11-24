# Development Rules (wasmedge-agent fork)

This repo is the runtime-swap fork of prime-agent (see README.md and DESIGN.md).
These rules replace the upstream AGENTS.md for fork development; upstream's
original rules remain in git history and apply when contributing upstream.

## Conversational Style

- No fluff. Keep answers short, concise, technical.
- No emojis in commits, issues, PR comments, or code.

## Fork context

- Design authority: `DESIGN.md` (decisions D1–D28) and `REPORT.md`. Consult the
  decision log before re-deciding anything.
- Naming (D25, executed): D25 held the binary, package names, `piConfig.name`,
  env prefixes, and the config dir at upstream identities until M5. That rename
  has landed, so the canonical surface is now `wasmedge-agent`,
  `WASMEDGE_AGENT_*`, and `~/.wasmedge-agent`. The old spellings survive only as
  the one-release fallbacks the CHANGELOG documents. `cargo run -p xtask -- branding`
  fails the build on any literal in its FORBIDDEN list that is not allowlisted
  with a reason; that list is what it knows about and nothing more, so a
  branded spelling it has never seen has to be added to it. Do not reintroduce
  one, and do not rename ad hoc.
- Upstream sync (SYNC strategy, DESIGN §7.3): the sync source is
  PrimeIntellect-ai/prime-agent. Check `git remote -v` before fetching -- the
  `upstream` remote name is not reserved for it. Our exclusive dirs:
  `crates/pa-core/src/tools/rust_cell/`, `poc/`, `docs/`, `DESIGN.md`, `REPORT.md`, root
  `README.md`, this file.
- The Python/IPython runtime is being removed (WP1); do not add new references
  to `core/kernel/`, `tools/ipython*`, or `prime-agent-runtime/`.

## Code Quality

- Read files in full before wide-ranging changes.
- Comment where an invariant or contract needs explanation.
- Keep existing API contracts unless the change calls for a migration.
- All keybindings must be configurable; add defaults to the matching object.

## Commands

- Run `cargo run --locked -p xtask -- check` for native source checks, branding, report links, formatting and all-target compilation.
- Build with `cargo build --release --locked --bin wasmedge-agent`.
- Run `cargo test --release --locked --workspace --lib` and relevant integration tests. Use the scripted provider for CLI tests. With WasmEdge and the prepared WASI template installed, run `cargo test --release --locked -p pa-cli --test native_cells -- --ignored`.
- Build guest crates and fixtures with `cargo build --release`; keep `[profile.dev.package."*"] debug = false` in workspace manifests.

## Git

- Feature work on branches (`runtime/…`, `bench/…`); merge to `main` when
  the repository check and the relevant tests are green.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`); one concern per
  commit; no Assisted-by/Co-Authored-By trailers.
- Never `git add -A` in shared worktrees; stage explicit paths.
- Never modify already-released CHANGELOG sections.
