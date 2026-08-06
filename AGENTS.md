# Development Rules (wasmedge-agent fork)

This repo is the runtime-swap fork of prime-agent (see README.md and DESIGN.md).
These rules replace the upstream AGENTS.md for fork development; upstream's
original rules remain in git history and apply when contributing upstream.

## Conversational Style

- No fluff. Keep answers short, concise, technical.
- No emojis in commits, issues, PR comments, or code.

## Fork context

- Design authority: `DESIGN.md` (decisions D1–D25) and `REPORT.md`. Consult the
  decision log before re-deciding anything.
- Incubation naming (D25): binary, package names, `piConfig.name`, env prefixes
  (`PRIME_AGENT_*`), and the config dir keep upstream identities until M5. Do
  not rename ad hoc.
- Upstream sync (SYNC strategy, DESIGN §7.3): `upstream` remote points at
  PrimeIntellect-ai/prime-agent. Our exclusive dirs: `core/rust-cell/`,
  `poc/`, `docs/`, `DESIGN.md`, `REPORT.md`, root `README.md`, this file.
- The Python/IPython runtime is being removed (WP1); do not add new references
  to `core/kernel/`, `tools/ipython*`, or `prime-agent-runtime/`.

## Code Quality

- Read files in full before wide-ranging changes.
- Comments only where there is real ambiguity; no `any` unless unavoidable.
- No inline `await import()` / `import()` types — top-level imports only.
- Never remove or downgrade code to silence type errors from outdated deps.
- All keybindings must be configurable; add defaults to the matching object.
- NEVER modify `packages/ai/src/models.generated.ts` directly; update
  `packages/ai/scripts/generate-models.ts`.

## Commands

- After code changes: `npm run check` from the repo root — fix all errors,
  warnings, and infos before committing. (`check` does not run tests.)
- Building is allowed and expected: `npm run build` for the full workspace.
- Do not leave `npm run dev` watchers running after a task.
- Run package tests from the package root, e.g.
  `npx tsx ../../node_modules/vitest/dist/cli.js --run test/foo.test.ts`.
- If you create or modify a test file, run it and iterate until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` with the
  faux provider — no real provider APIs or paid tokens in tests.
- Rust (guest crates, fixtures): always `cargo build --release`; keep
  `[profile.dev.package."*"] debug = false` in workspace manifests.

## Git

- Feature work on branches (`runtime/…`, `bench/…`); merge to `main` when
  `npm run check` and the relevant tests are green.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`); one concern per
  commit; no Assisted-by/Co-Authored-By trailers.
- Never `git add -A` in shared worktrees; stage explicit paths.
- Never modify already-released CHANGELOG sections.
