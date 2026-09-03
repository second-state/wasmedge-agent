#!/usr/bin/env node
/** Repository-wide audit for Prime Agent branding remnants.
 *
 * Issue #2 requires that "a repository-wide public-surface audit finds no
 * unintended Prime Agent branding remnants". A human reading satisfies that
 * once and then rots: packages/{ai,agent,tui} are upstream direct-receive
 * zones (DESIGN.md 7.3), cherry-picked monthly, so a future sync can
 * reintroduce a branded literal into a fully renamed tree. This turns the
 * audit into a build step.
 *
 * The allowlist is the real deliverable, and its grain is the line, not the
 * file: each entry names a path glob plus the exact patterns permitted to
 * survive there, and why. A glob-only exemption would let one legitimate
 * wire value in a file excuse every other branded string in it -- a display
 * name, a comment, an unrelated identifier -- which is precisely how a
 * "clean" tree hides remnants. An entry that never actually suppresses an
 * occurrence is itself a failure: a stale exemption is how the next literal
 * gets in unnoticed. That check is per entry, not per glob, so a dead
 * exemption cannot hide behind a live one sharing its path.
 *
 * Exemption policy -- exempt only these, nothing else:
 *   1. Names that are not ours to change. Wire values, by their literal value
 *      ("prime-agent-traces", "ai.primeintellect.prime-agent"); paths another
 *      program owns (Prime Inference's ~/.prime/config.json, the verifiers
 *      harness's .vf-prime-agent); and upstream's own product, repository,
 *      vendor and directory names where the text is genuinely about upstream
 *      -- the fork's lineage, the MIT copyright line and attribution, the
 *      sync strategy's upstream slug, the credit on artwork that is still
 *      upstream's, and the Prime Inference sign-in copy, whose subject is
 *      that vendor's account. Never a display name, prose, or identifier of
 *      ours that merely sits near one.
 *   2. Historical records (DESIGN.md, REPORT.md, docs/m*-*.md,
 *      docs/benchmark-comparison-2026-08-10.md, released CHANGELOG.md
 *      sections) -- AGENTS.md forbids rewriting these, and rewriting a dated
 *      measurement to match today's branding would make it a lie. The dated
 *      artwork disclosure in assets/brand/ sits here too, and is explicitly
 *      TEMPORARY.
 *   3. Deliberately-kept legacy strings the code cannot do without
 *      (config.ts's upstream fallback default ".prime/agent"; the legacy
 *      source path the one-time config-dir move names in migrations.ts; the
 *      compatibility window's legacy command, env names and packed bin).
 *   4. This file's own self-reference: it necessarily names what it forbids.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Literals that must not appear outside the allowlist.
 *
 *  Four of these exist because of defects this audit missed the first time.
 *  `.prime/agent` only ever matched the joined-string spelling, so the TUI's
 *  hardcoded config path -- written `join(home, ".prime", "agent")` -- was
 *  invisible to the check for the whole rebrand; the quoted-segment pattern
 *  closes that. And the brand-asset names (PRIME_BUTTERFLY_LOGO,
 *  themes/prime-logo.ts, assets/brand/prime-butterfly.svg) matched no pattern
 *  at all, so the logo surface could drift back without a word. The third is
 *  the underscore spelling: install.sh is POSIX sh and named 96 of its
 *  functions and variables prime_agent_*, 385 occurrences of them, and the
 *  hyphenated pattern could not see one -- in the single file users are told
 *  to pipe into a shell and are most likely to read. The fourth is CamelCase:
 *  twenty identifiers across ten source files kept the old product name, and
 *  no pattern here could see a single one.
 *
 *  The first ten are stale branding. The last two are its mirror image, and
 *  are here because a rebrand fails in both directions: a wire value that was
 *  correctly preserved in code can still be *wrongly rebranded* in a doc, a
 *  test, or a client, and nothing about that is visible as a stale literal.
 *  A consumer written from a doc publishing "ai.primeintellect.wasmedge-agent"
 *  looks up a key the agent never emits and silently sees no metadata -- no
 *  error, just empty extensions. Both preserved wire values get a mirror.
 *
 *  "Prime Intellect" is the vendor rather than the product, and is here
 *  because the product sweep could not see it: the OAuth callback page, which
 *  is rendered for Anthropic, OpenAI Codex and MCP logins and has nothing to
 *  do with Prime Inference, titled its browser tab "Prime Intellect
 *  authentication successful" for every new user through the whole rebrand.
 *  The legitimate survivors are few and named one by one below: the MIT
 *  copyright line, the fork's attribution, the artwork credit, and the Prime
 *  Inference sign-in copy, where the vendor really is the subject. */
const FORBIDDEN = [
	{ re: /PRIME_AGENT_/, label: "PRIME_AGENT_ environment prefix" },
	{ re: /prime_agent_/, label: "branded shell identifier prefix prime_agent_" },
	{ re: /\.prime\/agent/, label: "legacy config directory .prime/agent" },
	{
		re: /["']\.prime["']/,
		label: 'legacy config directory as a split path segment (join(..., ".prime", "agent"))',
	},
	{
		re: /PRIME_(?:BUTTERFLY|LOGO)/,
		label: "brand-asset identifier (PRIME_BUTTERFLY_*, PRIME_LOGO_*)",
	},
	{
		re: /prime-(?:butterfly|logo)/,
		label: "brand-asset filename or module (prime-butterfly, prime-logo)",
	},
	{ re: /prime-agent/, label: "legacy command or package name prime-agent" },
	{
		// The CamelCase spelling, which no other pattern could see: twenty
		// identifiers across ten source files -- wasmEdgeAgentMeta, the ACP
		// _meta interfaces, the traces credential helpers -- kept the old
		// product name through the whole rebrand, several of them sitting
		// directly beside a renamed constant whose value is a preserved wire
		// value. Identifiers rename; only values are pinned.
		re: /[Pp]rimeAgent/,
		label: "legacy product name in an identifier (PrimeAgent, primeAgent)",
	},
	// Case-insensitive, because the case-sensitive form missed a docs example
	// that searched the web for "prime agent skills" -- user-visible product
	// wording, in a file users copy from. Only the two-word display name is
	// case-folded: making the whole product-name family case-insensitive would
	// double-report every violation the hyphenated and underscored patterns
	// already catch, and the only additional hits in the tree are two poc/
	// variables naming upstream's own binary.
	{ re: /\bprime agent\b/i, label: "legacy product display name Prime Agent (any case)" },
	{ re: /Prime Intellect/, label: "upstream vendor display name Prime Intellect" },
	{
		re: /ai\.primeintellect\.wasmedge-agent/,
		label: 'wrongly rebranded ACP _meta namespace (the wire value is "ai.primeintellect.prime-agent")',
	},
	{
		re: /wasmedge-agent-traces/,
		label: 'wrongly rebranded traces provider id (the wire value is "prime-agent-traces")',
	},
];

/** Matches an entire line unconditionally. Used only by the whole-file
 *  historical-record and self-reference exemptions (policy categories 2 and
 *  4 above) -- everywhere else, `allow` patterns name a specific literal. */
const ANY_LINE = /^[\s\S]*$/;

/** A changelog's Unreleased section is not history.
 *
 *  The released sections are exempt because AGENTS.md forbids rewriting them
 *  and a rewritten dated entry would be a lie. Neither reason covers
 *  Unreleased: it is this release's notes, still being written, and it is
 *  where an upstream sync lands its own release lines. Under the whole-file
 *  exemption, live Prime Agent branding could arrive there and ship with no
 *  build failure.
 *
 *  So lines inside that section are matched against `<path>#unreleased`
 *  rather than `<path>`. The released-history glob cannot reach that name, and
 *  the survivors an Unreleased section legitimately needs -- it documents the
 *  legacy command, the legacy variable prefix and every preserved wire value
 *  by name -- have to be listed one at a time, exactly like everywhere else. */
const UNRELEASED_SCOPE = "#unreleased";
const CHANGELOG_PATH_RE = /(^|\/)CHANGELOG\.md$/;
// Markdown allows up to three spaces of indentation before an ATX heading, and
// a fourth makes it a code block rather than a heading. Both expressions have
// to agree on that: if only one of them saw an indented heading, an indented
// "## [Unreleased]" would either escape the scope or never leave it.
const CHANGELOG_HEADING_RE = /^ {0,3}##\s/;
const UNRELEASED_HEADING_RE = /^ {0,3}##\s*\[?\s*unreleased\b/i;

/** Per-line scan paths for a changelog, or undefined for any other file. */
function changelogScopedPaths(path, lines) {
	if (!CHANGELOG_PATH_RE.test(path)) return undefined;
	let inUnreleased = false;
	return lines.map((line) => {
		if (CHANGELOG_HEADING_RE.test(line)) inUnreleased = UNRELEASED_HEADING_RE.test(line);
		return inUnreleased ? `${path}${UNRELEASED_SCOPE}` : path;
	});
}

/** Each entry: a path glob, the literal patterns allowed to survive on a
 *  matching line there, and why. A hit is excused only when its line matches
 *  the glob *and* at least one `allow` pattern -- everything else in that
 *  file still fails. */
const ALLOWLIST = [
	{
		glob: "packages/coding-agent/src/core/prime-inference-auth.ts",
		allow: [/"prime-agent-traces"/],
		reason: "prime-agent-traces provider id is a wire value (rule R1); only the quoted literal survives",
	},
	{
		glob: "packages/coding-agent/src/core/provider-display-names.ts",
		allow: [/"prime-agent-traces"/],
		reason: "the prime-agent-traces key is a wire value (rule R1); its mapped display name is not, and must rebrand",
	},
	{
		glob: "packages/coding-agent/src/modes/acp/acp-meta.ts",
		allow: [/"ai\.primeintellect\.prime-agent"/],
		reason: "ACP _meta namespace ai.primeintellect.prime-agent is a wire value (rule R1); only the quoted literal survives",
	},
	{
		glob: "packages/coding-agent/src/config.ts",
		allow: [/"\.prime\/agent"/],
		reason: "CONFIG_DIR_NAME's upstream fallback default must survive for backward compatibility; only that literal is exempt",
	},
	{
		glob: "packages/coding-agent/src/config.ts",
		allow: [/PRIME_AGENT_\*/, /`PRIME_AGENT_\$\{suffix\}`/, /PRIME_AGENT_SESSION_DIR/],
		reason:
			"the one-release env-name compatibility window cannot read or document a PRIME_AGENT_* fallback without naming the prefix it falls back to (rule R3), and getSessionDirEnvOverride's ordering comment cannot describe the collision it fixes without naming the one variable that used to outrank a current name; only the doc-comment's literal asterisked prefix, readLegacyEnv's template literal and that one name are exempt, so a bare PRIME_AGENT_ added anywhere else here still fails",
	},
	{
		glob: "packages/coding-agent/src/config.ts",
		allow: [/"prime-agent"/, /'prime-agent'/],
		reason:
			"warnIfLegacyAlias must name the legacy command literally to detect and warn about it for one release (rule R3); only the quoted comparison value and the quoted value inside the warning string are exempt",
	},
	{
		glob: "packages/coding-agent/src/migrations.ts",
		allow: [/~\/\.prime\/agent/],
		reason: "the one-time config-dir move cannot document the directory it migrates from without naming it (rule R3); only the ~/-rooted legacy path is exempt, so a bare .prime/agent added here still fails",
	},
	{
		glob: "packages/coding-agent/src/core/autonomous.ts",
		allow: [/":\(exclude\)\.vf-prime-agent"/],
		reason: "the .vf-prime-agent directory is created by the external verifiers harness, not by us (rule R1): renaming our git pathspec would not rename what that harness writes, it would only stop excluding it and make harness artifacts read as workspace changes",
	},
	{
		glob: "packages/coding-agent/src/core/refinement/refinement.ts",
		allow: [/"prime-agent\.refinement"/],
		reason: "the /refine customType is a wire value (rule R1): it is written into session JSONL and matched back by exact equality, exactly like prime-agent-traces and the ACP _meta namespace. Only the quoted literal survives -- the product name in this file's prompts still has to rebrand",
	},
	{
		glob: "packages/coding-agent/test/refinement.test.ts",
		allow: [/"prime-agent\.refinement"/],
		reason: "the covering test pins that customType by value (rule R1); asserting only that the constant exists would let a later edit rebrand the on-disk value and silently empty every existing /refine history",
	},
	{
		glob: "packages/coding-agent/test/release-pack-manifest.test.ts",
		allow: [/"prime-agent": "dist\/bundle\/prime-agent\.js"/, /"dist\/bundle\/prime-agent\.js"/],
		reason:
			"the covering test asserts the generated bin map still installs the legacy command for the one-release window (rule R3), which is what makes warnIfLegacyAlias reachable on a real install at all, and pins the alias's own entry-point path by value -- comparing the constant with itself would let a rename move the file out from under the bin entry. Only that quoted key-and-target pair and that quoted path, both of which the packer is allowed to emit, are exempt here",
	},
	{
		glob: "packages/coding-agent/test/legacy-alias-invocation.test.ts",
		allow: [/"prime-agent"/, /'prime-agent' is deprecated/, /PRIME_AGENT_CODING_AGENT_DIR/, /PRIME_AGENT_SESSION_DIR/],
		reason:
			"the covering test asserts the generated bin map still installs the legacy command for the one-release window (rule R3), which is what makes warnIfLegacyAlias reachable on a real install at all, and pins the alias's own entry-point path by value -- comparing the constant with itself would let a rename move the file out from under the bin entry. Only that quoted key-and-target pair and that quoted path, both of which the packer is allowed to emit, are exempt here",
	},
	{
		glob: "packages/coding-agent/test/legacy-alias-invocation.test.ts",
		allow: [
			/"prime-agent"/,
			/'prime-agent' is deprecated/,
			/PRIME_AGENT_CODING_AGENT_DIR/,
			/PRIME_AGENT_SESSION_DIR/,
			/join\(base, "\.prime", "agent"\)/,
			/toContain\("\.prime\/agent"\)/,
		],
		reason:
			"the end-to-end alias test installs the legacy command name as a bin symlink and asserts the exact notice warnIfLegacyAlias writes, its neighbours set the legacy agent-dir and session-dir variables to prove the early-return drain and the post-theme drain each surface a fallback that really fired, and the failing-startup cases build a legacy home directory and assert the warning names it (rule R3); only the invoked command name, that one clause of the notice, those two variable names, and those two anchored calls are exempt",
	},
	{
		glob: "packages/coding-agent/src/modes/acp/acp-events.ts",
		allow: [/"prime-agent-bash"/],
		reason: "BASH_TOOL_CALL_PREFIX leaves the process in every bash tool-call id and is what an ACP client correlates a call's updates by, so it is a wire value (rule R1); only the quoted literal survives, so this file's other identifiers and prose still have to rebrand",
	},
	{
		glob: "packages/coding-agent/test/acp-events.test.ts",
		allow: [/"prime-agent-bash-r1"/, /"prime-agent-bash"/],
		reason: "the covering test names the id value clients were actually given, for both the run-scoped and the bare form (rule R1); every other assertion in that file compares bashToolCallId() with itself and would hold for any spelling. Only those two quoted literals are exempt",
	},
	{
		glob: "packages/coding-agent/src/modes/daemon/daemon-socket-dir.ts",
		allow: [/`prime-agent-\$\{daemonSocketDirSuffix\(\)\}`/, /"\\\\\\\\\.\\\\pipe\\\\prime-agent-daemon"/],
		reason:
			"legacyDaemonEndpoint() names the two endpoints a previously released build created -- the per-user socket directory and the Windows named pipe -- which makes both values rather than names of ours (rule R1): renaming either would rename nothing, it would only stop finding the daemon still listening there, the one thing the config-directory migration has to warn about. Only that template literal and that quoted pipe name are exempt, so the live endpoints beside them still fail if they regress",
	},
	{
		glob: "packages/coding-agent/src/modes/daemon/daemon-protocol.ts",
		allow: [/"prime-agent\.daemon"/],
		reason: "DAEMON_PROTOCOL_NAME is serialized into the handshake and compared by exact equality across a socket, which makes it a wire value (rule R1); only the quoted literal survives, so the comments and identifiers around it still have to rebrand",
	},
	{
		glob: "packages/coding-agent/test/daemon-client.test.ts",
		allow: [/"prime-agent\.daemon"/],
		reason: "the covering test pins DAEMON_PROTOCOL_NAME by value and fabricates peer hello frames carrying that literal (rule R1); comparing the constant to itself would pass for any spelling, including one that makes an external client reject compatible messages. Only the quoted literal is exempt",
	},
	{
		glob: "packages/coding-agent/test/daemon-launch.test.ts",
		allow: [/"prime-agent\.daemon"/],
		reason: "the launch tests fabricate a daemon hello as a peer writes it, so the protocol name is data on the wire and not a reference to our constant (rule R1); only the quoted literal is exempt",
	},
	{
		glob: "packages/coding-agent/test/heartbeat-catalog.test.ts",
		allow: [/"prime-agent\.daemon"/],
		reason: "the heartbeat fixture carries a peer's protocol name in a hello frame, the same wire value (rule R1); only the quoted literal is exempt",
	},
	{
		glob: "packages/coding-agent/test/daemon-multiclient-bench.ts",
		allow: [/"prime-agent\.daemon"/],
		reason: "the multiclient bench harness speaks the protocol as a peer does and writes its name into every hello it sends (rule R1); only the quoted literal is exempt",
	},
	{
		glob: "packages/coding-agent/src/core/messages.ts",
		allow: [/"prime-agent\.worker_recovery"/, /"prime-agent\.update_restart"/, /"prime-agent\.update_complete"/],
		reason: "three persisted session-entry types, wire values under rule R1 on the same footing as prime-agent.refinement: each is written into session JSONL and is what a reload, an export, or a consumer outside this repository classifies the record by. Only these three quoted literals survive, so a branded identifier or a line of prose added to this file still fails",
	},
	{
		glob: "packages/coding-agent/test/session-wire-custom-types.test.ts",
		allow: [/"prime-agent\.worker_recovery"/, /"prime-agent\.update_restart"/, /"prime-agent\.update_complete"/],
		reason: "the covering test pins those three customTypes by value and again in the reloaded session file (rule R1); asserting only that the constants exist would let a later edit rebrand the on-disk values and orphan every record already written. Only the three quoted literals are exempt",
	},
	{
		glob: "packages/coding-agent/test/config.test.ts",
		allow: [
			/PRIME_AGENT_CODING_AGENT_SESSION_DIR/,
			/PRIME_AGENT_CODING_AGENT_DIR/,
			/PRIME_AGENT_INTERNAL_DAEMON_WORKER/,
			/PRIME_AGENT_SESSION_DIR/,
			/"\/usr\/local\/bin\/prime-agent"/,
		],
		reason:
			"the covering test for the one-release compatibility window must set and assert the exact legacy names readLegacyEnv and warnIfLegacyAlias fall back to (rule R3); the two session-dir names are the pair whose precedence against the current names is the whole point of those tests; only these five literal values are exempt -- a bare PRIME_AGENT_ or prime-agent added anywhere else in this file still fails",
	},
	{
		glob: "packages/coding-agent/test/migrations.test.ts",
		allow: [
			/PRIME_AGENT_CODING_AGENT_DIR/,
			/PRIME_AGENT_SESSION_DIR/,
			/"\\\\\\\\\.\\\\pipe\\\\prime-agent-daemon"/,
		],
		reason:
			"the non-interactive and session-dir deprecation-surfacing tests drive the same legacy env vars through readLegacyEnv, resolveLegacyNameWarningsEarly, and runMigrations to prove each warning reaches the snapshot, and the endpoint test pins the Windows named pipe a previously released build created (rules R3 and R1) -- comparing legacyDaemonEndpoint with itself would hold for a spelling that finds nothing. Only these two literal values and that quoted pipe name are exempt",
	},
	{
		glob: "packages/coding-agent/test/version-check.test.ts",
		allow: [/PRIME_AGENT_DOWNLOAD_BASE_URL/],
		reason:
			"the covering test sets the legacy download-base-url variable to prove getLatestPiVersion falls back to it for one release (rule R3); only that one literal value is exempt",
	},
	{
		glob: "packages/coding-agent/test/agent-traces.test.ts",
		allow: [/PRIME_AGENT_TRACES_API_KEY/],
		reason:
			"the covering test sets the legacy trace-api-key variable to prove getWasmEdgeAgentTraceCredential falls back to it for one release (rule R3); only that one literal value is exempt",
	},
	{
		glob: "packages/coding-agent/test/prime-inference-auth.test.ts",
		allow: [/PRIME_AGENT_TRACES_BASE_URL/],
		reason:
			"the covering test sets the legacy trace-base-url variable to prove resolveWasmEdgeAgentTracesBaseUrl falls back to it for one release (rule R3); only that one literal value is exempt",
	},
	{
		glob: "packages/coding-agent/test/websearch-host.test.ts",
		allow: [/PRIME_AGENT_WEBSEARCH_TIMEOUT/, /PRIME_AGENT_WEBSEARCH_NUM_RESULTS/],
		reason:
			"the covering test sets the legacy websearch timeout/num-results variables to prove the handler falls back to them for one release (rule R3); only these two literal values are exempt",
	},
	{
		glob: "packages/coding-agent/test/settings-manager.test.ts",
		allow: [/\.prime\/agent/],
		reason:
			"the covering test for Task 6's project-local fallback names the legacy directory in its describe/it titles so a failure reads as what broke (rule R3); only the joined form in those titles is exempt here, and the split path segments the test builds are exempted separately below",
	},
	{
		glob: "packages/coding-agent/test/skills.test.ts",
		allow: [/\.prime\/agent/],
		reason:
			"the covering test for Task 6's project-local skills fallback names the legacy directory in its describe/it titles so a failure reads as what broke (rule R3); only the joined form in those titles is exempt here, and the split path segments the test builds are exempted separately below",
	},
	{
		glob: "packages/coding-agent/README.md",
		allow: [/`PRIME_AGENT_\*`/],
		reason:
			"the environment-variable table cannot document the one-release fallback without naming the prefix that is falling back (rule R3); only the backticked asterisked prefix in that one row is exempt, so a concrete PRIME_AGENT_<NAME> added anywhere else in this README still fails",
	},
	{
		glob: "packages/coding-agent/docs/acp.md",
		allow: [/"ai\.primeintellect\.prime-agent"/],
		reason: "the doc must publish the exact _meta namespace acp-meta.ts emits (rule R1); a client written from a rebranded key would look up something the agent never sends and silently see no metadata",
	},
	{
		glob: ".gitignore",
		allow: [/\.prime\/agent\//],
		reason: "the legacy project-local config dir stays ignored until project-local migration lands (rule R3), so a developer's pre-rebrand directory does not surface as untracked in the meantime",
	},
	{
		glob: "install.sh",
		allow: [
			/PRIME_AGENT_<suffix>/,
			/PRIME_AGENT_DOWNLOAD_BASE_URL/,
			/PRIME_AGENT_RELEASE_CHANNEL/,
			/PRIME_AGENT_PACKAGE/,
			/PRIME_AGENT_CMD/,
			/PRIME_AGENT_INSTALLER_PLAIN/,
			/PRIME_AGENT_VERSION/,
			/PRIME_AGENT_SHELL_PROFILE/,
		],
		reason:
			"install.sh's own one-release compatibility window (rule R3): each PRIME_AGENT_<NAME> is a legacy fallback wasmedge_agent_warn_if_legacy_env checks for and each real reader falls back to, mirroring readLegacyEnv on the TypeScript side; only these seven literal names (plus the doc comment's generic placeholder) are exempt, so a bare PRIME_AGENT_ added anywhere else in this file still fails",
	},
	{
		glob: "scripts/pack-wasmedge-agent-release.mjs",
		allow: [/"prime-agent": PUBLIC_LEGACY_BIN_TARGET/, /"dist\/bundle\/prime-agent\.js"/],
		reason:
			"the packed manifest installs the legacy command as a second bin for the one-release window (rule R3), which is what makes warnIfLegacyAlias reachable at all -- without this entry the CHANGELOG's promise that prime-agent keeps working is unbacked. That command needs an entry point of its own, because Windows npm shims launch node with the target path and an alias sharing the canonical entry cannot tell it was invoked as the alias. Only that one bin-map entry, in the form naming the shared constant, and that constant's own quoted path are exempt, so the artifact names and the default package name in the same file still fail if they regress",
		allow: [/"prime-agent": "dist\/bundle\/cli\.js"/],
		reason:
			"the packed manifest installs the legacy command as a second bin for the one-release window (rule R3), which is what makes warnIfLegacyAlias reachable at all -- without this entry the CHANGELOG's promise that prime-agent keeps working is unbacked. That command needs an entry point of its own, because Windows npm shims launch node with the target path and an alias sharing the canonical entry cannot tell it was invoked as the alias. Only that one bin-map entry, in the form naming the shared constant, and that constant's own quoted path are exempt, so the artifact names and the default package name in the same file still fail if they regress",
	},
	{
		glob: "poc/**",
		allow: [/prime-agent/, /PRIME_AGENT_/, /~\/\.prime\/agent/, /"\.prime"/],
		reason: "poc/ is the Phase 0 proof of concept that runs against stock upstream prime-agent -- a different program, with its own command name, its own PRIME_AGENT_* env vars and its own config dir, which the bench harness builds as split path segments. Naming it is naming upstream, not naming us (rule R1). Only those four upstream literals are exempt: 'Prime Agent' as a display name still fails here, as do this fork's own group-F paths",
	},
	{
		glob: "assets/brand/wasmedge-butterfly.svg",
		allow: [/upstream's Prime Agent butterfly/],
		reason:
			"TEMPORARY 2026-09-03: the mark is renamed but not redrawn -- the artwork is still upstream's, and the SVG carries a dated comment saying so. Only that disclosure line is exempt (rule R2). Deleting the comment makes this entry stale and fails the build, which is the point: the mark must be redrawn before release (spec section 10), and until then the file must say whose it is. One entry per file, so losing either disclosure fails on its own",
	},
	{
		glob: "assets/brand/wasmedge-butterfly-black.svg",
		allow: [/upstream's Prime Agent butterfly/],
		reason:
			"TEMPORARY 2026-09-03: the dark-background mark, same disclosure and same terms as wasmedge-butterfly.svg above; only that line is exempt (rule R2)",
	},
	{
		glob: "packages/agent/README.md",
		allow: [/upstream's Prime Agent/, /alt="Prime Intellect butterfly mark"/],
		reason:
			"TEMPORARY 2026-09-03: the header mark is renamed but not redrawn -- the artwork is still upstream's, so the alt text credits the vendor whose mark it is and a dated comment above it says so (rule R2). Only those two literals are exempt. Deleting the disclosure makes this entry stale and fails the build, which is the point: the mark must be redrawn before release (spec section 10), and until then the file must say whose it is. One entry per file, so losing any one disclosure fails on its own",
	},
	{
		glob: "packages/ai/README.md",
		allow: [/upstream's Prime Agent/, /alt="Prime Intellect butterfly mark"/],
		reason:
			"TEMPORARY 2026-09-03: the header mark is renamed but not redrawn -- the artwork is still upstream's, so the alt text credits the vendor whose mark it is and a dated comment above it says so (rule R2). Only those two literals are exempt. Deleting the disclosure makes this entry stale and fails the build, which is the point: the mark must be redrawn before release (spec section 10), and until then the file must say whose it is. One entry per file, so losing any one disclosure fails on its own",
	},
	{
		glob: "packages/coding-agent/README.md",
		allow: [/upstream's Prime Agent/, /alt="Prime Intellect butterfly mark"/],
		reason:
			"TEMPORARY 2026-09-03: the header mark is renamed but not redrawn -- the artwork is still upstream's, so the alt text credits the vendor whose mark it is and a dated comment above it says so (rule R2). Only those two literals are exempt. Deleting the disclosure makes this entry stale and fails the build, which is the point: the mark must be redrawn before release (spec section 10), and until then the file must say whose it is. One entry per file, so losing any one disclosure fails on its own",
	},
	{
		glob: "packages/tui/README.md",
		allow: [/upstream's Prime Agent/, /alt="Prime Intellect butterfly mark"/],
		reason:
			"TEMPORARY 2026-09-03: the header mark is renamed but not redrawn -- the artwork is still upstream's, so the alt text credits the vendor whose mark it is and a dated comment above it says so (rule R2). Only those two literals are exempt. Deleting the disclosure makes this entry stale and fails the build, which is the point: the mark must be redrawn before release (spec section 10), and until then the file must say whose it is. One entry per file, so losing any one disclosure fails on its own",
	},
	{
		glob: "README.md",
		allow: [
			/\[Prime Agent\]\(https:\/\/github\.com\/PrimeIntellect-ai\/prime-agent\)/,
			/\[\*\*Prime Agent\*\*\]\(https:\/\/github\.com\/PrimeIntellect-ai\/prime-agent\)/,
			/Prime Agent's design/,
			/\[Prime Intellect\]\(https:\/\/primeintellect\.ai\)/,
		],
		reason:
			"the fork's lineage and its MIT attribution name upstream's product, repository and vendor, which are upstream's to name and not ours to rebrand (rule R1): the opening sentence saying what this is a fork of, the Attribution section's credit to Prime Intellect, and the one clause naming whose design the fork keeps. A mechanical sweep over these produced \"built on WasmEdge Agent by Prime Intellect\", which is simply false. Only those four literals are exempt, so this fork's own status and install prose in the same file still fails",
	},
	{
		glob: "LICENSE",
		allow: [/Copyright \(c\) 2026 Prime Intellect/],
		reason:
			"the MIT copyright line states who holds the copyright (rule R1). It is a legal notice, not a display name, and rebranding it would make it false. Only that one line is exempt",
	},
	{
		glob: "AGENTS.md",
		allow: [/fork of prime-agent/, /PrimeIntellect-ai\/prime-agent/, /`prime-agent-runtime\/`/],
		reason:
			"three references to upstream rather than to us (rule R1): what this repo is a fork of, the slug the sync strategy in DESIGN.md 7.3 syncs from, and `prime-agent-runtime/`, an upstream directory deleted in WP1 that the rule forbidding new references to it has to name in order to forbid it. Only these three literals are exempt, so this file's own naming rules still fail if they reintroduce a branded name",
	},
	{
		glob: "docs/benchmark-comparison-2026-08-10.md",
		allow: [
			/Prime Agent vs WasmEdge Agent benchmark/,
			/stock Prime Agent's IPython runtime/,
			/`PrimeIntellect-ai\/prime-agent`/,
			/prime-agent-clean-bench\/prime-agent\.sh/,
			/`PRIME_AGENT_CODING_AGENT_DIR`/,
		],
		reason:
			"a dated record of a campaign that was really run on 2026-08-10 against the real upstream binary (rule R2): the two products compared, the upstream worktree pinned by SHA, the literal command line that launched it, and the environment variable the harness actually set. Rebranding any of them would make a measurement record claim something that did not happen. Only these five literals are exempt, so a newly branded string added to this file still fails",
	},
	{
		glob: "examples/showcase/README.md",
		allow: [/a fork of Prime Agent/],
		reason:
			"the tour's opening sentence names the upstream product this is a fork of (rule R1); only that clause is exempt, so the showcase's own prose about this fork still fails",
	},
	{
		glob: "packages/ai/src/env-api-keys.ts",
		allow: [/"\.prime", "config\.json"/],
		reason:
			"~/.prime/config.json is Prime Inference's own credentials file, the provider's and not the agent's (rule R1); only that two-segment pair is exempt, so a split-form legacy agent path -- join(home, \".prime\", \"agent\") -- added here still fails, and so does the joined form",
	},
	{
		glob: "packages/ai/scripts/generate-models.ts",
		allow: [/"\.prime", "config\.json"/],
		reason:
			"the model generator reads Prime Inference's own ~/.prime/config.json for the API key it needs (rule R1); only that two-segment pair is exempt, so a split-form legacy agent path added here still fails",
	},
	{
		glob: "packages/coding-agent/src/core/prime-inference-auth.ts",
		allow: [/"\.prime", "config\.json"/],
		reason:
			"primeConfigPath() resolves Prime Inference's own ~/.prime/config.json, which the rebrand must not move (rule R1); only that two-segment pair is exempt, so a split-form legacy agent path added here still fails",
	},
	{
		glob: "packages/coding-agent/test/auth-flows.test.ts",
		allow: [/join\(tempDir, "\.prime"\)/],
		reason:
			"the auth-flow test builds Prime Inference's own config directory under a temp HOME (rule R1); anchored to that one call, so a split-form legacy agent path added elsewhere in this file still fails",
	},
	{
		glob: "packages/coding-agent/src/config.ts",
		allow: [/"\.prime"/],
		reason:
			"getProjectConfigDir's project-local legacy fallback joins the directory it falls back to as separate path segments (rule R3); only the quoted first segment is exempt. This is the exact spelling the old joined-only pattern could not see, which is how the TUI's hardcoded path survived the whole rebrand",
	},
	{
		glob: "packages/coding-agent/src/migrations.ts",
		allow: [/"\.prime"/],
		reason:
			"the one-time config-dir move joins the source directory it migrates from as separate path segments (rule R3); only the quoted first segment is exempt",
	},
	{
		glob: "packages/tui/test/tui-log-path.test.ts",
		allow: [/includes\("\.prime"\)/],
		reason:
			"the assertion is negative -- it proves the TUI log path does not land under the legacy directory -- so it has to name the directory it forbids (rule R3); anchored to that one call, so any other use of the segment in this file still fails",
	},
	{
		glob: "packages/coding-agent/test/config.test.ts",
		allow: [/"\.prime"/],
		reason:
			"the covering test for the project-local legacy fallback builds and asserts the directory getProjectConfigDir falls back to, as the same split path segments the source uses (rule R3); only the quoted segment is exempt",
	},
	{
		glob: "packages/coding-agent/test/migrations.test.ts",
		allow: [/"\.prime"/],
		reason:
			"the covering tests for the config-dir move and the project-local deprecation build the legacy tree they migrate from, as split path segments (rule R3); only the quoted segment is exempt",
	},
	{
		glob: "packages/coding-agent/test/config-command-warnings.test.ts",
		allow: [/join\(base, "project", "\.prime", "agent"\)/],
		reason:
			"the covering test builds the legacy project-local config directory the config command falls back to, so it can prove the command reports that fallback before it exits (rule R3); anchored to that one call, so any other .prime reference added to this file still fails",
	},
	{
		glob: "packages/coding-agent/test/postinstall.test.ts",
		allow: [/PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL/],
		reason:
			"the covering test sets the legacy bootstrap variable to prove postinstall falls back to it and, now, reports the deprecation before it exits (rule R3); only that one literal value is exempt",
	},
	{
		glob: "packages/coding-agent/test/postinstall.test.ts",
		allow: [/join\(base, "\.prime", "agent"\)/],
		reason:
			"the covering test for the postinstall ordering builds the legacy home tree the install-time migration moves, as split path segments (rule R3); anchored to that one call, so any other .prime reference added to this file still fails",
	},
	{
		glob: "packages/coding-agent/test/settings-manager.test.ts",
		allow: [/"\.prime"/],
		reason:
			"the covering test for the project-local settings fallback writes into the legacy directory it reads back from, as split path segments (rule R3); only the quoted segment is exempt",
	},
	{
		glob: "packages/coding-agent/test/skills.test.ts",
		allow: [/"\.prime"/],
		reason:
			"the covering test for the project-local skills fallback creates a skill inside the legacy directory, as split path segments (rule R3); only the quoted segment is exempt",
	},
	{
		glob: "packages/ai/src/utils/oauth/oauth-page.ts",
		allow: [/upstream's Prime Agent butterfly/],
		reason:
			"TEMPORARY 2026-09-03: the OAuth callback page inlines the same mark the two SVG files hold, renamed but not redrawn, and now carries the same dated disclosure (rule R2). Only that line is exempt -- the page's own title and aria-label are ours, are shown for Anthropic, OpenAI Codex and MCP logins, and are rebranded",
	},
	{
		glob: "packages/coding-agent/src/modes/interactive/components/login-dialog.ts",
		allow: [/Connect your Prime Intellect account/],
		reason:
			"Prime Inference sign-in copy: the account being connected really is a Prime Intellect one, and the provider is untouched by the rebrand (rule R1). Only that clause is exempt, so prose of ours elsewhere in this file still fails",
	},
	{
		glob: "packages/coding-agent/src/modes/interactive/components/prime-onboarding-splash.ts",
		allow: [/login with Prime Intellect/],
		reason:
			"the same Prime Inference sign-in, on the onboarding splash's action label (rule R1); only that clause is exempt",
	},
	{
		glob: "packages/coding-agent/src/modes/interactive/interactive-mode.ts",
		allow: [/Signing in to Prime Intellect/],
		reason:
			"the progress line for the Prime Inference sign-in the splash starts (rule R1); only that clause is exempt, in a file that is otherwise all ours",
	},
	{
		glob: "packages/coding-agent/test/login-dialog.test.ts",
		allow: [/Connect your Prime Intellect account/],
		reason: "the covering test asserts that Prime Inference sign-in copy verbatim (rule R1); only that clause is exempt",
	},
	{
		glob: "packages/coding-agent/test/prime-onboarding-splash.test.ts",
		allow: [/with Prime Intellect/, /your Prime Intellect account/, /connected to Prime Intellect/],
		reason:
			"the covering test asserts the splash's Prime Inference sign-in copy and rejects several earlier wordings of it by name (rule R1); only those three clause shapes are exempt",
	},
	{
		glob: "packages/coding-agent/test/interactive-mode-status.test.ts",
		allow: [/Signing in to Prime Intellect/],
		reason: "the covering test pins that Prime Inference progress line verbatim (rule R1); only that clause is exempt",
	},
	{
		glob: "packages/coding-agent/test/suite/regressions/4658-onboarding-transitions.test.ts",
		allow: [/Signing in to Prime Intellect/],
		reason:
			"the onboarding-transition regression test records that same Prime Inference progress line in its expected transcript (rule R1); only that clause is exempt",
	},
	{
		glob: "packages/coding-agent/CHANGELOG.md#unreleased",
		allow: [
			/Renamed Prime Agent to WasmEdge Agent/,
			/`primeAgentMeta`/,
			/`prime-agent`/,
			/`pkill -f prime-agent`/,
			/`~\/\.prime\/agent\/`/,
			/`PRIME_AGENT_\*`/,
			/`prime-agent-traces`/,
			/`ai\.primeintellect\.prime-agent`/,
			/`prime-agent-bash`/,
			/`prime-agent\.daemon`/,
			/`prime-agent\.refinement`/,
			/`prime-agent\.worker_recovery`/,
			/`prime-agent\.update_restart`/,
			/`prime-agent\.update_complete`/,
			/"Prime Intellect authentication successful"/,
			/Prime Intellect's\./,
		],
		reason:
			"the Unreleased section is scanned like source, not like released history, and these are the literals a rename announcement cannot avoid naming: the product renamed from, the one CamelCase identifier whose rename would be undocumented without naming it, the legacy command the alias installs, the command that stops a pre-rename daemon, the legacy config directory and variable prefix, the eight preserved wire values, and the OAuth page's old tab title with the one clause saying whose name it was. Each is backticked or quoted, so a bare Prime Agent or prime-agent added to a new release line still fails here",
	},
	{
		glob: "**/CHANGELOG.md",
		allow: [ANY_LINE],
		reason: "released sections only; AGENTS.md forbids rewriting them. Unreleased lines are scanned as CHANGELOG.md#unreleased and this glob cannot reach them",
	},
	{
		glob: "packages/coding-agent/docs/acp.md",
		allow: [/"ai\.primeintellect\.prime-agent"/],
		reason: "the doc must publish the exact _meta namespace acp-meta.ts emits (rule R1); a client written from a rebranded key would look up something the agent never sends and silently see no metadata",
	},
	{
		glob: ".gitignore",
		allow: [/\.prime\/agent\//],
		reason: "the legacy project-local config dir stays ignored until project-local migration lands (rule R3), so a developer's pre-rebrand directory does not surface as untracked in the meantime",
	},
	{
		glob: "poc/**",
		allow: [/prime-agent/, /PRIME_AGENT_/, /~\/\.prime\/agent/],
		reason: "poc/ is the Phase 0 proof of concept that runs against stock upstream prime-agent -- a different program, with its own command name, its own PRIME_AGENT_* env vars and its own config dir. Naming it is naming upstream, not naming us (rule R1). Only those three upstream literals are exempt: 'Prime Agent' as a display name still fails here, as do this fork's own group-F paths",
	},
	{
		glob: "assets/brand/wasmedge-butterfly*.svg",
		allow: [/upstream's Prime Agent butterfly/],
		reason:
			"TEMPORARY 2026-09-03: the brand marks are renamed but not redrawn -- the artwork is still upstream's, and each SVG carries a dated comment saying so. Only that disclosure line is exempt (rule R2). Deleting the comment makes this entry stale and fails the build, which is the point: the mark must be redrawn before release (spec section 10), and until then the file must say whose it is",
	},
	{ glob: "**/CHANGELOG.md", allow: [ANY_LINE], reason: "released sections; AGENTS.md forbids rewriting them" },
	{ glob: "DESIGN.md", allow: [ANY_LINE], reason: "historical record of the fork's own decisions" },
	{ glob: "REPORT.md", allow: [ANY_LINE], reason: "historical record of the fork's own decisions" },
	{ glob: "docs/m*-*.md", allow: [ANY_LINE], reason: "dated milestone reports; historical record" },
	{ glob: "scripts/check-branding.mjs", allow: [ANY_LINE], reason: "this file necessarily names what it forbids" },
];

/** Minimal glob: * matches within a segment, ** matches across segments. */
function globToRegExp(glob) {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") {
					out += "(?:.*/)?"; // zero or more path segments, or none at all
					i += 2;
				} else {
					out += ".*";
					i++;
				}
			} else {
				out += "[^/]*";
			}
		} else if (".+?^${}()|[]\\".includes(c)) {
			out += `\\${c}`;
		} else {
			out += c;
		}
	}
	return new RegExp(`^${out}$`);
}

const ALLOW_RES = ALLOWLIST.map((entry, index) => ({ ...entry, index, pathRe: globToRegExp(entry.glob) }));

/** Replaces every substring of `line` matched by an applicable entry's allow
 *  patterns with equal-length blanks, and reports which entries did the
 *  replacing. Entries are reported by index rather than by glob: several
 *  entries may share one path (a file can hold two unrelated survivors for two
 *  unrelated reasons), and crediting them all because one of them fired is how
 *  a stale exemption hides behind a live neighbour. Masking (rather than
 *  skipping the line outright) is what keeps an unrelated branded string on the
 *  same line from being excused. */
function maskAllowed(path, line) {
	let masked = line;
	const contributing = [];
	for (const entry of ALLOW_RES) {
		if (!entry.pathRe.test(path)) continue;
		for (const pattern of entry.allow) {
			const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
			const global = new RegExp(pattern.source, flags);
			const next = masked.replace(global, (m) => " ".repeat(m.length));
			if (next !== masked) contributing.push(entry.index);
			masked = next;
		}
	}
	return { masked, contributing };
}

/** Pure matcher. Kept free of I/O so the self-test can exercise it directly.
 *  Returns the violations plus the indices of the allowlist entries that
 *  actually suppressed one -- an entry that suppresses nothing is stale. */
export function scanFile(path, text) {
	const violations = [];
	const usedEntries = new Set();
	const lines = text.split("\n");
	const scopedPaths = changelogScopedPaths(path, lines);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const rawHits = FORBIDDEN.filter(({ re }) => re.test(line));
		if (rawHits.length === 0) continue;
		const { masked, contributing } = maskAllowed(scopedPaths?.[i] ?? path, line);
		const maskedHits = FORBIDDEN.filter(({ re }) => re.test(masked));
		if (maskedHits.length < rawHits.length) {
			for (const index of contributing) usedEntries.add(index);
		}
		for (const { label } of maskedHits) {
			violations.push({ path, line: i + 1, label, text: line.trim().slice(0, 120) });
		}
	}
	// A forbidden phrase can straddle a line break. Markdown reflows, so a
	// paragraph wrapped after "Prime" reads to a human as "Prime Agent" while
	// the line-based pass above sees two innocent halves -- which is how a
	// shipped skill reference described the product by its old name for the
	// whole rebrand.
	//
	// Each seam is checked on the pair joined the way a renderer joins it, and
	// a hit is reported only when neither line produced it alone, so nothing
	// found above is reported twice. Allowlist entries apply here exactly as
	// they do per line, and a seam that an entry suppresses counts as that
	// entry doing work: an allowed phrase reflowed across a break is masked
	// only on the joined string, and crediting it there is what keeps a live
	// exemption from reading as stale.
	for (let i = 0; i + 1 < lines.length; i++) {
		const joined = `${lines[i].trimEnd()} ${lines[i + 1].trimStart()}`;
		const rawHits = FORBIDDEN.filter(({ re }) => re.test(joined));
		if (rawHits.length === 0) continue;
		// The left line's scope. A phrase cannot meaningfully straddle the
		// heading that would put the two lines in different ones.
		const scanPath = scopedPaths?.[i] ?? path;
		const { masked, contributing } = maskAllowed(scanPath, joined);
		const maskedHits = FORBIDDEN.filter(({ re }) => re.test(masked));
		if (maskedHits.length < rawHits.length) {
			for (const index of contributing) usedEntries.add(index);
		}
		if (maskedHits.length === 0) continue;
		const leftMasked = maskAllowed(scanPath, lines[i]).masked;
		const rightMasked = maskAllowed(scopedPaths?.[i + 1] ?? path, lines[i + 1]).masked;
		for (const { re, label } of maskedHits) {
			if (re.test(leftMasked) || re.test(rightMasked)) continue;
			violations.push({
				path,
				line: i + 1,
				label: `${label}, split across lines`,
				text: joined.trim().slice(0, 120),
			});
		}
	}
	return { violations, usedEntries };
}

/** Convenience wrapper over scanFile for callers that only need the count. */
export function scanText(path, text) {
	return scanFile(path, text).violations;
}

/** Runs on every invocation. A drift guard never observed to fail is
 *  indistinguishable from one that cannot fail, and this costs microseconds.
 *  Returns whether it passed rather than exiting itself: process.exit() can
 *  truncate a long console.error when stdout is a pipe rather than a TTY or
 *  a file, since Node may write to a pipe asynchronously and exit() does not
 *  wait for the write to land. Setting process.exitCode and returning lets
 *  the process exit only once the event loop -- and the write -- drains. */
function selfTest() {
	const failures = [];
	const cases = [
		["src/a.ts", "const x = process.env.PRIME_AGENT_HOME;", 1],
		// The shell spelling. Case matters: the uppercase env names install.sh
		// still falls back to are a separate, allowlisted concern.
		["install.sh", "prime_agent_screen_title=$1", 1],
		["install.sh", "wasmedge_agent_screen_title=$1", 0],
		["src/a.ts", 'join(home, ".prime/agent")', 1],
		["src/a.ts", 'const name = "prime-agent";', 1],
		["src/a.ts", "// Prime Agent starts here", 1],
		// The case-folded form, which the case-sensitive pattern could not see.
		["packages/coding-agent/docs/skills.md", 'web_search::run("prime agent skills")?;', 1],
		["packages/coding-agent/docs/skills.md", 'web_search::run("WasmEdge Agent skills")?;', 0],
		// Word boundaries: the underscored and hyphenated spellings stay the
		// business of their own patterns, and do not double-report here.
		["poc/bench/run.ts", "const FORK_PRIME_AGENT = join(REPO, \"wasmedge-agent.sh\");", 0],
		["src/a.ts", 'const ok = "wasmedge-agent";', 0],
		// The CamelCase spelling, in both an upper and a lower initial.
		["src/a.ts", "export interface PrimeAgentSessionMeta {", 1],
		["src/a.ts", "export function primeAgentMeta(payload) {", 1],
		["src/a.ts", "export function getPrimeAgentTraceCredential() {", 1],
		["src/a.ts", "export interface WasmEdgeAgentSessionMeta {", 0],
		["src/a.ts", "export function wasmEdgeAgentMeta(payload) {", 0],
		["packages/ai/src/env-api-keys.ts", "const k = process.env.PRIME_API_KEY;", 0],
		["DESIGN.md", "PRIME_AGENT_ stays here", 0],
		["packages/coding-agent/src/core/prime-inference-auth.ts", 'id = "prime-agent-traces";', 0],
		// A wire value shares a line with a branded string that must still be
		// caught -- the defect a glob-only exemption could not see.
		[
			"packages/coding-agent/src/core/prime-inference-auth.ts",
			'export const PRIME_AGENT_TRACES_PROVIDER_ID = "prime-agent-traces";',
			1,
		],
		["packages/coding-agent/src/core/provider-display-names.ts", '"prime-agent-traces": "Prime Agent Traces",', 1],
		[
			"packages/coding-agent/src/modes/acp/acp-meta.ts",
			'export const PRIME_AGENT_META_NAMESPACE = "ai.primeintellect.prime-agent";',
			1,
		],
		["packages/coding-agent/src/config.ts", 'export const CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".prime/agent";', 0],
		["packages/coding-agent/src/migrations.ts", " * Move ~/.prime/agent to ~/.wasmedge-agent exactly once.", 0],
		// migrations.ts's exemption is the ~/-rooted path only, not the bare
		// directory name.
		["packages/coding-agent/src/migrations.ts", 'join(agentDir, ".prime/agent")', 1],
		["packages/coding-agent/src/core/autonomous.ts", '":(exclude).vf-prime-agent",', 0],
		// Only autonomous.ts's pathspec entry is external; its prose is ours.
		["packages/coding-agent/src/core/autonomous.ts", "// Prime Agent snapshots the worktree", 1],
		[
			"packages/coding-agent/src/core/refinement/refinement.ts",
			'export const REFINEMENT_CUSTOM_TYPE = "prime-agent.refinement";',
			'export const LEGACY_REFINEMENT_CUSTOM_TYPE = "prime-agent.refinement";',
			0,
		],
		// Only refinement.ts's persisted customType survives; the product name in
		// that file's prompts must still rebrand.
		["packages/coding-agent/src/core/refinement/refinement.ts", "You are Prime Agent's /refine subsystem.", 1],
		[
			"packages/coding-agent/test/refinement.test.ts",
			'expect(REFINEMENT_CUSTOM_TYPE).toBe("prime-agent.refinement");',
			0,
		],
		[
			"packages/coding-agent/src/modes/daemon/daemon-protocol.ts",
			'export const DAEMON_PROTOCOL_NAME = "prime-agent.daemon";',
			0,
		],
		["packages/coding-agent/src/modes/acp/acp-events.ts", 'const BASH_TOOL_CALL_PREFIX = "prime-agent-bash";', 0],
		// ...and acp-events.ts's exemption is that prefix, not a command name in it.
		["packages/coding-agent/src/modes/acp/acp-events.ts", 'const cmd = "prime-agent";', 1],
		// daemon-protocol.ts's exemption is the handshake value, not its prose.
		["packages/coding-agent/src/modes/daemon/daemon-protocol.ts", "// Prime Agent's daemon speaks this", 1],
		// The three persisted daemon/update session entry types: wire values under
		// rule R1, on the same footing as the /refine entry type -- each is written
		// into session JSONL and matched by exact equality when it is read back.
		[
			"packages/coding-agent/src/core/messages.ts",
			'export const UPDATE_RESTART_CUSTOM_TYPE = "prime-agent.update_restart";',
			0,
		],
		["packages/coding-agent/src/core/messages.ts", " *  written by Prime Agent", 1],
		[
			"packages/coding-agent/test/session-wire-custom-types.test.ts",
			'expect(WORKER_RECOVERY_CUSTOM_TYPE).toBe("prime-agent.worker_recovery");',
			'expect(LEGACY_REFINEMENT_CUSTOM_TYPE).toBe("prime-agent.refinement");',
			0,
		],
		// refinement.test.ts's exemption is that one asserted value, not its prose.
		["packages/coding-agent/test/refinement.test.ts", 'it("rebrands Prime Agent", () => {', 1],
		// Wrongly-new branding: a preserved wire value rebranded by mistake is
		// as broken as a stale one, and looks clean to every stale-only check.
		["packages/coding-agent/docs/acp.md", '"ai.primeintellect.wasmedge-agent": {', 1],
		// The correct key is the one the code emits, and the doc may publish it.
		["packages/coding-agent/docs/acp.md", '    "ai.primeintellect.prime-agent": {', 0],
		["packages/coding-agent/docs/acp.md", "Prime Agent sends this", 1],
		[".gitignore", ".prime/agent/", 0],
		["src/a.ts", 'const id = "wasmedge-agent-traces";', 1],
		// ...but the renamed identifiers around the traces provider id are correct
		// and must not trip it: different separators, different case.
		["src/a.ts", 'export const WASMEDGE_AGENT_TRACES_PROVIDER_ID = "prime-agent-traces";', 1],
		["src/a.ts", "stringEnv(WASMEDGE_AGENT_TRACES_API_KEY)", 0],
		// poc/ names upstream, a different program...
		["poc/bench/run.ts", 'const PRIME_AGENT_SH = process.env.BENCH_PRIME_AGENT ?? "prime-agent";', 0],
		["poc/bench/README.md", "Requirements: `~/.prime/agent/models.json` configured", 0],
		// ...but only by those two literals; poc/README.md's display name is still
		// ours to fix.
		["poc/README.md", "Prime Agent is the product", 1],
		["packages/coding-agent/src/config.ts", "// User Config Paths (~/.prime/agent/*)", 1],
		// The split-argument spelling of the legacy config dir. Nothing in the
		// old pattern set saw this, which is exactly how the TUI's hardcoded
		// config path stayed invisible for the length of the rebrand.
		["src/a.ts", 'join(home, ".prime", "agent")', 1],
		["src/a.ts", "const d = join(cwd, '.prime', 'agent');", 1],
		["packages/coding-agent/src/config.ts", 'const legacy = join(cwd, ".prime", "agent");', 0],
		["packages/coding-agent/src/migrations.ts", 'const legacyDir = join(homedir(), ".prime", "agent");', 0],
		// Prime Inference's own config file is the provider's, sharing the legacy
		// directory prefix.
		["packages/ai/src/env-api-keys.ts", 'const p = _join(_homedir(), ".prime", "config.json");', 0],
		// ...but env-api-keys.ts's exemption is that config-file pair, not any legacy
		// agent path in it -- neither the joined spelling nor the split one the old
		// entry let through.
		["packages/ai/src/env-api-keys.ts", 'const legacy = ".prime/agent";', 1],
		["packages/ai/src/env-api-keys.ts", 'const legacy = _join(_homedir(), ".prime", "agent");', 1],
		["packages/tui/test/tui-log-path.test.ts", 'assert.ok(!tuiLogPath("d.log").includes(".prime"));', 0],
		["packages/tui/test/tui-log-path.test.ts", 'const legacy = join(home, ".prime", "agent");', 1],
		// Brand-asset identifiers and filenames, which matched no pattern at all
		// before: the logo surface could drift back without a word.
		["src/a.ts", 'import { PRIME_BUTTERFLY_LOGO } from "./themes/prime-logo.js";', 2],
		["src/a.ts", "const lines = PRIME_LOGO_LINES.length;", 1],
		["src/a.ts", 'srcset="../../assets/brand/prime-butterfly.svg"', 1],
		["src/a.ts", 'import { WASMEDGE_BUTTERFLY_LOGO } from "./themes/wasmedge-logo.js";', 0],
		["src/a.ts", 'srcset="../../assets/brand/wasmedge-butterfly.svg"', 0],
		// The renamed marks still hold upstream's artwork, and each SVG says so.
		["assets/brand/wasmedge-butterfly.svg", "<!-- TEMPORARY 2026-09-03: this mark is still upstream's Prime Agent butterfly,", 0],
		// Removing that disclosure is not allowed to pass quietly either: the
		// entry stops suppressing anything and main() reports it as stale.
		// The vendor name. Ours to fix wherever the subject is not the vendor --
		// this exact line shipped on the OAuth callback page rendered for every
		// Anthropic, OpenAI Codex and MCP login.
		["packages/ai/src/utils/oauth/oauth-page.ts", 'title: "Prime Intellect authentication successful",', 1],
		["src/a.ts", 'const label = "Sign in with Prime Intellect";', 1],
		// ...but a legal notice, an artwork credit and the Prime Inference sign-in
		// copy all have Prime Intellect as their actual subject.
		["LICENSE", "Copyright (c) 2026 Prime Intellect", 0],
		[
			"packages/agent/README.md",
			'<img alt="Prime Intellect butterfly mark" src="../../assets/brand/wasmedge-butterfly-black.svg" width="88">',
			0,
		],
		[
			"packages/coding-agent/src/modes/interactive/components/login-dialog.ts",
			'theme.fg("muted", "Connect your Prime Intellect account to enable Prime Inference models."),',
			0,
		],
		// login-dialog.ts's exemption is that sign-in clause, not the vendor's name.
		["packages/coding-agent/src/modes/interactive/components/login-dialog.ts", "// Prime Intellect ships this", 1],
		// A phrase wrapped across a line break, which neither half shows on its
		// own. This is how a shipped skill reference kept the old product name.
		["docs/x.md", "ships a Rust crate. Prime\nAgent mounts the crate", 1],
		["docs/x.md", "ships a Rust crate. WasmEdge\nAgent mounts the crate", 0],
		["docs/x.md", "credit to Prime\nIntellect for the mark", 1],
		// Reported once, by the line pass, not again by the seam pass.
		["docs/x.md", "Prime Agent line\nsecond line", 1],
		// A reflowed *allowed* phrase is still allowed, and crediting the entry
		// there is what stops a live exemption reading as stale.
		["examples/showcase/README.md", "This is a fork of Prime\nAgent, with changes", 0],
		// The seam does not invent a match out of two unrelated lines.
		["docs/x.md", "the word Prime\nis not a product", 0],
		// ** glob coverage, including the path-separator boundary it must enforce.
		["CHANGELOG.md", "Prime Agent line", 0],
		["packages/coding-agent/CHANGELOG.md", "Prime Agent line", 0],
		["packages/aiCHANGELOG.md", "Prime Agent line", 1],
		// A released section keeps its blanket exemption; the Unreleased section
		// above it does not, and the heading after it closes the scope again.
		[
			"packages/coding-agent/CHANGELOG.md",
			"# Changelog\n\n## [Unreleased]\n\n## [0.7.0] - 2026-08-05\n\n- Changed self-updates to report Prime Agent versions.\n",
			0,
		],
		["packages/coding-agent/CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n- Prime Agent got faster.\n", 1],
		// Indented headings are still headings, in both directions: an indented
		// Unreleased heading opens the scope...
		["packages/coding-agent/CHANGELOG.md", "# Changelog\n\n   ## [Unreleased]\n\n- Prime Agent got faster.\n", 1],
		// ...and an indented release heading closes it again.
		[
			"packages/coding-agent/CHANGELOG.md",
			"# Changelog\n\n## [Unreleased]\n\n   ## [0.7.0] - 2026-08-05\n\n- Prime Agent got faster.\n",
			0,
		],
		// Four spaces is a code block, not a heading, so the scope does not open.
		["packages/coding-agent/CHANGELOG.md", "# Changelog\n\n    ## [Unreleased]\n\n- Prime Agent got faster.\n", 0],
		// What an Unreleased section legitimately needs is named, not blanket.
		[
			"packages/coding-agent/CHANGELOG.md",
			"# Changelog\n\n## [Unreleased]\n\n- `prime-agent` keeps working for one release.\n",
			0,
		],
		// The exemption is the coding-agent changelog's Unreleased section, not
		// every package changelog's.
		["packages/ai/CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n- `prime-agent` keeps working.\n", 1],
	];
	for (const [path, text, expected] of cases) {
		const got = scanText(path, text).length;
		if (got !== expected) {
			failures.push(`scanText(${path}, ${JSON.stringify(text)}) = ${got}, want ${expected}`);
		}
	}
	if (failures.length > 0) {
		console.error(["check-branding self-test failed:", ...failures.map((f) => `- ${f}`)].join("\n"));
		return false;
	}
	return true;
}

function main() {
	if (!selfTest()) {
		process.exitCode = 1;
		return;
	}
	if (process.argv.includes("--self-test")) return;

	const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf-8" })
		.split("\0")
		.filter(Boolean);

	const violations = [];
	const matchedAllow = new Set();
	for (const path of tracked) {
		let text;
		try {
			text = readFileSync(path, "utf-8");
		} catch {
			continue; // binary or unreadable; nothing to match
		}
		const { violations: fileViolations, usedEntries } = scanFile(path, text);
		violations.push(...fileViolations);
		for (const index of usedEntries) matchedAllow.add(index);
	}

	const stale = ALLOWLIST.filter((_, index) => !matchedAllow.has(index));
	const failures = [
		...violations.map((v) => `${v.path}:${v.line} ${v.label} -- ${v.text}`),
		...stale.map((e) => `stale allowlist entry suppresses nothing: ${e.glob} (${e.reason})`),
	];

	if (failures.length > 0) {
		console.error(["Branding check failed:", ...failures.map((f) => `- ${f}`)].join("\n"));
		process.exitCode = 1;
		return;
	}
	console.log(
		`check-branding: clean (${tracked.length} tracked files, ${ALLOWLIST.length} allowlist entries)`,
	);
}

main();
