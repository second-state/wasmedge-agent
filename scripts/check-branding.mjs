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
 *      sync strategy's upstream slug, and the Prime Inference sign-in copy,
 *      whose subject is that vendor's account. Never a display name, prose,
 *      or identifier of ours that merely sits near one.
 *   2. Historical records (DESIGN.md, REPORT.md, docs/m*-*.md,
 *      docs/benchmark-comparison-2026-08-10.md, released CHANGELOG.md
 *      sections) -- AGENTS.md forbids rewriting these, and rewriting a dated
 *      measurement to match today's branding would make it a lie.
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
	// One case-insensitive pattern for the underscored prefix rather than two
	// case-sensitive ones. They were split so an uppercase env name and a
	// lowercase shell identifier could carry different labels, and the split
	// was a hole: PRIME_Agent_ matched neither.
	{ re: /prime_agent_/i, label: "branded identifier prefix prime_agent_ / PRIME_AGENT_ (any case)" },
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
	// Case-insensitive: the case-sensitive form let Prime-Agent and PRIME-AGENT
	// through, which is visible product branding in the surface a reader sees.
	{ re: /prime-agent/i, label: "legacy command or package name prime-agent (any case)" },
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
	// The product name is not the only way to name the product. Two comments
	// described the interface as "the prime brand TUI" -- prose, in active
	// source, in a file the rename otherwise went through -- and every pattern
	// above missed it, because none of them is the word the sentence used.
	// Branding wording gets its own rule for the same reason the display name
	// is case-folded: it is the spelling someone reaches for when they are
	// writing about the product rather than calling it.
	{
		re: /\bprime[-\s]brand/i,
		label: "legacy product branding wording (Prime brand, Prime-branded, any case)",
	},
	{ re: /Prime Intellect/, label: "upstream vendor display name Prime Intellect" },
	{
		re: /ai\.primeintellect\.wasmedge-agent/i,
		label: 'wrongly rebranded ACP _meta namespace (the wire value is "ai.primeintellect.prime-agent")',
	},
	{
		re: /wasmedge-agent-traces/i,
		label: 'wrongly rebranded traces provider id (the wire value is "prime-agent-traces")',
	},
	// Upstream's package identity, at the places that name it rather than the
	// manifests that declare it. REQUIRED pins each of the four names in its
	// own package.json, which stops the declaration being renamed; nothing
	// stopped a doc, an install command, or an import from naming a rebranded
	// spelling instead -- a package nothing publishes, in the one line a
	// reader is most likely to copy and run.
	{
		re: /@[a-z0-9-]*wasmedge[a-z0-9-]*\//,
		label: "rebranded package scope (the packages stay under @earendil-works)",
	},
	{
		re: /@earendil-works\/(?!pi-)/,
		label: "rebranded package name under @earendil-works (every one of ours is pi-*)",
	},
	// The third way to misname a package, and the one the two rules above
	// leave open: keep the pi-* name and move it to a scope that is not ours.
	// `@other/pi-ai` is neither a wasmedge scope nor a non-pi name under
	// @earendil-works, and the manifest pins go on passing because the four
	// declarations are still intact -- so a doc, an install command, a path
	// mapping or an import could point at a package nobody publishes and the
	// audit would agree. The names are listed rather than matched as pi-*,
	// because pi-* is upstream's whole namespace and a reference to one of
	// their packages under their own scope is not our business.
	//
	// @mariozechner is exempt: it is upstream's own scope for these very
	// packages, the one the fork renamed away from, and a reference to a
	// package that really is published there -- a recorded session fixture
	// predating the rename holds a hundred of them -- is history rather than a
	// defect. The lookahead also skips the wasmedge scopes, which the rule
	// above already reports: one line, one violation.
	{
		re: /@(?!earendil-works\/|mariozechner\/)(?![a-z0-9-]*wasmedge)[a-z0-9-]+\/pi-(?:agent-core|coding-agent|ai|tui)\b/,
		label: "one of our package names under another scope (they are published under @earendil-works)",
	},
	// The rest of the preserved wire values. Each already has an allowlist
	// entry pinning its correct literal, which stops the value being *renamed
	// away*; nothing stopped a doc, a test, or a client from being written
	// against the rebranded spelling instead. The failure is silent in a
	// different way for each: a tool call the client cannot correlate, a
	// handshake compared by exact equality that never matches, and a session
	// entry a reload or an export classifies as nothing at all.
	//
	// Case-insensitive, here and for the two mirrors above. Every one of these
	// contracts is compared byte for byte at the other end, so a case variant
	// is exactly as broken as the lowercase spelling and, being the form a
	// human writes when they are thinking of the product rather than the
	// protocol, is the likelier way to write it: `WasmEdge-Agent-traces` in a
	// doc, `WASMEDGE-AGENT.daemon` in a client. The correct literal elsewhere
	// still satisfies the pin, so nothing else notices. Unlike the product
	// name, these have no legitimate spelling in any case for the pattern to
	// start double-reporting.
	{
		re: /wasmedge-agent-bash/i,
		label: 'wrongly rebranded ACP bash tool-call id prefix (the wire value is "prime-agent-bash")',
	},
	{
		re: /wasmedge-agent\.daemon/i,
		label: 'wrongly rebranded daemon protocol name (the wire value is "prime-agent.daemon")',
	},
	{
		re: /wasmedge-agent\.(?:worker_recovery|update_restart|update_complete|refinement)/i,
		label: 'wrongly rebranded persisted session entry type (the wire values are "prime-agent.<type>")',
	},
];

/** Our environment namespace, closed.
 *
 *  The spec keeps the upstream PI_* lineage along with the `pi` command and the
 *  @earendil-works/pi-* dependency names, and the way that lineage breaks is a
 *  PI_* name reappearing under our prefix. Enumerating the PI_* names to forbid
 *  the rebranded spelling of each was the first attempt, and it can only ever
 *  cover the names someone remembered: PI_SPAWN_HOOK sat in an example
 *  extension the whole time, so PI_SPAWN_HOOK -> WASMEDGE_AGENT_SPAWN_HOOK
 *  passed. Every name upstream adds in a future sync has the same hole.
 *
 *  Turning it around closes it. This is the list of names that are ours, and a
 *  WASMEDGE_AGENT_* name that is not on it fails -- whatever it was called
 *  before, and whether or not anyone thought to enumerate that. The cost is
 *  that adding one of our own variables means adding it here, which is the
 *  right cost: our environment surface is a thing worth having written down.
 *
 *  WASMEDGE_AGENT_INTERNAL_* and WASMEDGE_AGENT_TEST_* are covered by prefix.
 *  The spec renames internal and test variables outright, with no compatibility
 *  window, precisely because no user sets them; enumerating each daemon handle
 *  and test marker here would be churn with no reader. The gap that leaves --
 *  a PI_* name rebranded into one of those two prefixes -- is what the pins in
 *  REQUIRED catch from the other side. */
const PRODUCT_ENV_NAMES = new Set([
	"WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL",
	"WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL",
	"WASMEDGE_AGENT_BUILD_ID",
	"WASMEDGE_AGENT_BUILD_ID_ENV",
	"WASMEDGE_AGENT_CARGO",
	"WASMEDGE_AGENT_CMD",
	"WASMEDGE_AGENT_CODING_AGENT_DIR",
	"WASMEDGE_AGENT_CODING_AGENT_SESSION_DIR",
	"WASMEDGE_AGENT_DOWNLOAD_BASE_URL",
	"WASMEDGE_AGENT_INSTALLER_PLAIN",
	"WASMEDGE_AGENT_INTERACTIVE_SELF_UPDATE",
	"WASMEDGE_AGENT_KERNEL_FORKSERVER",
	"WASMEDGE_AGENT_KERNEL_VENV",
	"WASMEDGE_AGENT_LAUNCHER_PATH",
	"WASMEDGE_AGENT_LAUNCHER_PATH_ENV",
	"WASMEDGE_AGENT_LEGACY_ALIAS",
	"WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS",
	"WASMEDGE_AGENT_META_NAMESPACE",
	"WASMEDGE_AGENT_NODE_INSTALLED_STANDALONE",
	"WASMEDGE_AGENT_OWNED_TEST",
	"WASMEDGE_AGENT_PACKAGE",
	"WASMEDGE_AGENT_PACKAGE_NAME",
	"WASMEDGE_AGENT_RELEASE_CHANNEL",
	"WASMEDGE_AGENT_SESSION_DIR",
	"WASMEDGE_AGENT_SHELL_PROFILE",
	"WASMEDGE_AGENT_SPLASH_PREVIEW_FRAMES",
	"WASMEDGE_AGENT_STANDALONE_NODE_BIN",
	"WASMEDGE_AGENT_STRESS_WORKERS",
	"WASMEDGE_AGENT_TEMPLATE_DIR",
	"WASMEDGE_AGENT_TOOLCHAIN",
	"WASMEDGE_AGENT_TRACES_API_KEY",
	"WASMEDGE_AGENT_TRACES_BASE_URL",
	"WASMEDGE_AGENT_TRACES_PROVIDER_ID",
	"WASMEDGE_AGENT_TRACES_PROVIDER_NAME",
	"WASMEDGE_AGENT_VERSION",
	"WASMEDGE_AGENT_WASMEDGE",
	"WASMEDGE_AGENT_WEBSEARCH_NUM_RESULTS",
	"WASMEDGE_AGENT_WEBSEARCH_TIMEOUT",
]);

const PRODUCT_ENV_PREFIXES = ["WASMEDGE_AGENT_INTERNAL_", "WASMEDGE_AGENT_TEST_"];
const PRODUCT_ENV_RE = /\bWASMEDGE_AGENT_[A-Z0-9_]+/g;

function unregisteredProductEnvNames(line) {
	const names = [];
	for (const [name] of line.matchAll(PRODUCT_ENV_RE)) {
		if (PRODUCT_ENV_NAMES.has(name)) continue;
		if (PRODUCT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
		if (!names.includes(name)) names.push(name);
	}
	return names;
}

/** Every rule's verdict on one line. The key identifies the rule that fired, so
 *  the seam pass can tell a hit it has already reported from a new one. */
function hitsFor(line) {
	const hits = FORBIDDEN.filter(({ re }) => re.test(line)).map(({ re, label }) => ({
		key: String(re),
		label,
	}));
	for (const name of unregisteredProductEnvNames(line)) {
		hits.push({
			key: `env:${name}`,
			label: `${name} is not one of our environment names (add it to PRODUCT_ENV_NAMES, or do not take a PI_* name)`,
		});
	}
	return hits;
}

/** Values that must still be where they are load-bearing.
 *
 *  FORBIDDEN plus the allowlist pins a value that is *renamed*: the allowlist
 *  entry naming its exact literal goes dead, and main() reports a dead entry.
 *  Neither can see a value that is simply gone, and neither sees one whose
 *  literal was never forbidden in the first place -- api.primeintellect.ai is
 *  a vendor's host, not our branding, so no pattern here has any reason to
 *  match it, and it could be replaced with a WasmEdge URL without one word
 *  from this audit. What the request would reach then is nobody's endpoint.
 *
 *  So: the literal, where it has to be, and the reason it is not ours to
 *  change. A rename that keeps something working still has to say so here,
 *  which is the point -- these are contracts with programs outside this build.
 *
 *  The glob is the load-bearing part, not decoration. "Somewhere in the tree"
 *  is satisfied by a test that asserts the value and a doc that mentions it,
 *  and both of those are edited in the same commit as the rename they
 *  describe: a pin that broad passes the exact change it exists to catch. So
 *  each value is pinned to the code that must still carry it -- the module for
 *  a single literal, `packages/*\/src/**` for a name whose readers move around
 *  as upstream syncs land.
 *
 *  The PI_* names are here as well as in the pattern above because the two
 *  catch different halves. The pattern catches the new name appearing; this
 *  catches the old one leaving. A rename does both, and either alone is
 *  enough to fail it. */
const REQUIRED = [
	{
		literal: "https://api.primeintellect.ai",
		glob: "packages/coding-agent/src/core/prime-inference-auth.ts",
		why: "the Prime Intellect API host the traces client and the whoami probe post to",
	},
	{
		literal: "https://app.primeintellect.ai",
		glob: "packages/coding-agent/src/core/prime-inference-auth.ts",
		why: "the Prime Intellect sign-in host the browser auth flow opens",
	},
	// Upstream's package identity, which the spec keeps for the same reason it
	// keeps the PI_* names: DESIGN.md section 7.1 retains the lineage, and these
	// are what npm resolves and what a `pi` on someone's PATH still runs. The
	// display name beside each of them is ours and is rebranded, which is
	// exactly why they need pinning: nothing about renaming the scope or the
	// bin looks like leftover branding to a stale-literal check.
	{
		literal: '"@earendil-works/pi-coding-agent"',
		glob: "packages/coding-agent/package.json",
		why: "the published package name",
	},
	{ literal: '"@earendil-works/pi-ai"', glob: "packages/ai/package.json", why: "the published package name" },
	{
		literal: '"@earendil-works/pi-agent-core"',
		glob: "packages/agent/package.json",
		why: "the published package name",
	},
	{ literal: '"@earendil-works/pi-tui"', glob: "packages/tui/package.json", why: "the published package name" },
	{
		literal: '"pi": "dist/bundle/cli.js"',
		glob: "packages/coding-agent/package.json",
		why: "the source bin, which the release packer renames to wasmedge-agent and the source keeps",
	},
	{ literal: '"pi-ai": "./dist/cli.js"', glob: "packages/ai/package.json", why: "the source bin" },
	// The PI_* lineage the spec keeps, one line per name so a removal names
	// itself.
	//
	// Three names are deliberately absent. PI_CODING_AGENT_DIR survives only as
	// upstream's example in a comment and in a packages/ai test that sets it
	// for a reader this fork's envPrefix no longer produces -- the live name is
	// WASMEDGE_AGENT_CODING_AGENT_DIR. PI_AI_ANTIGRAVITY_VERSION and
	// PI_NO_HARDWARE_CURSOR appear only in released changelog entries, which
	// are records of what upstream shipped rather than contracts this build
	// holds; pinning a historical record would stop it from ageing out.
	...[
		"PI_CACHE_RETENTION",
		"PI_CLEAR_ON_SHRINK",
		"PI_CODING_AGENT",
		"PI_DEBUG_REDRAW",
		"PI_FULLSCREEN",
		"PI_HARDWARE_CURSOR",
		"PI_MCP_OAUTH_CALLBACK_PORT",
		"PI_OAUTH_CALLBACK_HOST",
		"PI_OFFLINE",
		"PI_PACKAGE_DIR",
		"PI_SHARE_VIEWER_URL",
		"PI_SKIP_VERSION_CHECK",
		"PI_STARTUP_BENCHMARK",
		"PI_TIMING",
		"PI_TUI_DEBUG",
		"PI_TUI_LOG_DIR",
		"PI_TUI_WRITE_LOG",
	].map((literal) => ({
		literal,
		glob: "packages/*/src/**",
		why: "an upstream PI_* environment name the rebrand keeps, read from source",
	})),
	// The rest of the lineage, which lives outside packages/*/src: a fixture
	// contract, a suite opt-out, an example extension, and two names our own
	// code must never set. They are no less upstream's for not being in src,
	// and the one this list was widened for -- PI_SPAWN_HOOK -- was invisible
	// while the pins stopped at src.
	{
		literal: "PI_AGENT_DIR",
		glob: "packages/coding-agent/**",
		why: "upstream's own pre-rename agent directory, named by the session migration script and its fixture",
	},
	{
		literal: "PI_NO_LOCAL_LLM",
		glob: "packages/ai/test/**",
		why: "the opt-out the AI suite reads to skip its local-model tests",
	},
	{
		literal: "PI_TEST_INHERIT_ENV",
		glob: "packages/ai/test/**",
		why: "the provider-env scrubber's opt-out, declared as INHERIT_ENV_NAME",
	},
	{
		literal: "PI_SPAWN_HOOK",
		glob: "packages/coding-agent/examples/extensions/**",
		why: "the marker the bash-spawn-hook example puts in a child's environment",
	},
	{
		literal: "PI_WSL_CLIPBOARD_IMAGE_PATH",
		glob: "packages/coding-agent/test/**",
		why: "upstream's WSL clipboard path, asserted absent -- the pin keeps the assertion, not the variable",
	},
];

const REQUIRED_RES = REQUIRED.map((entry) => ({ ...entry, pathRe: globToRegExp(entry.glob) }));

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
			/PRIME_AGENT_TRACES_API_KEY/,
			/PRIME_AGENT_WEBSEARCH_TIMEOUT/,
			/"\/usr\/local\/bin\/prime-agent"/,
		],
		reason:
			"the covering test for the one-release compatibility window must set and assert the exact legacy names readLegacyEnv and warnIfLegacyAlias fall back to (rule R3); the two session-dir names are the pair whose precedence against the current names is the whole point of those tests, and the traces and websearch names are the ones no startup path reads, which is what the eager sweep exists to cover; only these seven literal values are exempt -- a bare PRIME_AGENT_ or prime-agent added anywhere else in this file still fails",
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
	},
	{
		glob: "poc/**",
		allow: [/prime-agent/, /PRIME_AGENT_/, /~\/\.prime\/agent/, /"\.prime"/],
		reason: "poc/ is the Phase 0 proof of concept that runs against stock upstream prime-agent -- a different program, with its own command name, its own PRIME_AGENT_* env vars and its own config dir, which the bench harness builds as split path segments. Naming it is naming upstream, not naming us (rule R1). Only those four upstream literals are exempt: 'Prime Agent' as a display name still fails here, as do this fork's own group-F paths",
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
		glob: "packages/coding-agent/src/modes/interactive/components/login-dialog.ts",
		allow: [/Connect your Prime Intellect account/],
		reason:
			"Prime Inference sign-in copy: the account being connected really is a Prime Intellect one, and the provider is untouched by the rebrand (rule R1). Only that clause is exempt, so prose of ours elsewhere in this file still fails",
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
			"the covering test rejects, by name, the earlier wordings of the Prime Inference sign-in the onboarding splash used to offer (rule R1); only those three clause shapes are exempt",
	},
	// The rename announcement lived in coding-agent's Unreleased section until
	// 0.0.1 was cut, and had an entry here naming each legacy literal it could
	// not avoid. Released sections are history and pass below; a new Unreleased
	// line that has to name a legacy identifier earns its own entry, named and
	// not blanket, the way that one was.
	{
		glob: "**/CHANGELOG.md",
		allow: [ANY_LINE],
		reason: "released sections only; AGENTS.md forbids rewriting them. Unreleased lines are scanned as CHANGELOG.md#unreleased and this glob cannot reach them",
	},
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

	// The name is a public surface too, and nothing was reading it. Every
	// pattern here was applied to what a file contains and never to what it is
	// called, so assets/brand/prime-logo.svg passed the audit outright: an
	// image, a generated module or a fixture need not repeat its own name
	// anywhere inside itself, and the two brand-asset patterns exist precisely
	// to catch filenames.
	//
	// Same patterns, same allowlist, reported at line 0 -- the violation is the
	// name rather than anything in the file.
	const { masked: maskedPath, contributing: pathEntries } = maskAllowed(path, path);
	const pathHits = hitsFor(maskedPath);
	if (pathHits.length < hitsFor(path).length) {
		for (const index of pathEntries) usedEntries.add(index);
	}
	for (const { label } of pathHits) {
		violations.push({ path, line: 0, label: `${label}, in the file name`, text: path });
	}

	const lines = text.split("\n");
	const scopedPaths = changelogScopedPaths(path, lines);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const rawHits = hitsFor(line);
		if (rawHits.length === 0) continue;
		const { masked, contributing } = maskAllowed(scopedPaths?.[i] ?? path, line);
		const maskedHits = hitsFor(masked);
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
		const rawHits = hitsFor(joined);
		if (rawHits.length === 0) continue;
		// The left line's scope. A phrase cannot meaningfully straddle the
		// heading that would put the two lines in different ones.
		const scanPath = scopedPaths?.[i] ?? path;
		const { masked, contributing } = maskAllowed(scanPath, joined);
		const maskedHits = hitsFor(masked);
		if (maskedHits.length < rawHits.length) {
			for (const index of contributing) usedEntries.add(index);
		}
		if (maskedHits.length === 0) continue;
		const leftMasked = maskAllowed(scanPath, lines[i]).masked;
		const rightMasked = maskAllowed(scopedPaths?.[i + 1] ?? path, lines[i + 1]).masked;
		const alreadyReported = new Set([...hitsFor(leftMasked), ...hitsFor(rightMasked)].map((hit) => hit.key));
		for (const { key, label } of maskedHits) {
			if (alreadyReported.has(key)) continue;
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
		// The shell spelling, which is the same pattern now: one report, not
		// two, for either case.
		["install.sh", "prime_agent_screen_title=$1", 1],
		["install.sh", "wasmedge_agent_screen_title=$1", 0],
		["src/a.ts", 'join(home, ".prime/agent")', 1],
		["src/a.ts", 'const name = "prime-agent";', 1],
		["src/a.ts", "// Prime Agent starts here", 1],
		// The case-folded form, which the case-sensitive pattern could not see.
		["packages/coding-agent/docs/skills.md", 'web_search::run("prime agent skills")?;', 1],
		["packages/coding-agent/docs/skills.md", 'web_search::run("WasmEdge Agent skills")?;', 0],
		// Branding wording, which names the product without using its name.
		["src/a.ts", " * Footer component for the prime brand TUI.", 1],
		["src/a.ts", "// a Prime-branded theme", 1],
		["src/a.ts", " * Footer component for the WasmEdge Agent TUI.", 0],
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
			0,
		],
		// refinement.test.ts's exemption is that one asserted value, not its prose.
		["packages/coding-agent/test/refinement.test.ts", 'it("rebrands Prime Agent", () => {', 1],
		// Wrongly-new branding: a preserved wire value rebranded by mistake is
		// as broken as a stale one, and looks clean to every stale-only check.
		["packages/coding-agent/docs/acp.md", '"ai.primeintellect.wasmedge-agent": {', 1],
		["packages/coding-agent/docs/acp.md", 'toolCallId: "wasmedge-agent-bash-1"', 1],
		["packages/coding-agent/docs/daemon.md", 'protocol: { name: "wasmedge-agent.daemon" }', 1],
		// The allowlist entries beside these pin one exact quoted literal each,
		// so the file that legitimately carries the preserved value gains no
		// cover for the rebranded one.
		[
			"packages/coding-agent/src/core/messages.ts",
			'export const UPDATE_RESTART_CUSTOM_TYPE = "wasmedge-agent.update_restart";',
			1,
		],
		[
			"packages/coding-agent/test/session-wire-custom-types.test.ts",
			'expect(WORKER_RECOVERY_CUSTOM_TYPE).toBe("wasmedge-agent.worker_recovery");',
			1,
		],
		[
			"packages/coding-agent/src/core/refinement/refinement.ts",
			'export const REFINEMENT_CUSTOM_TYPE = "wasmedge-agent.refinement";',
			1,
		],
		// The correct key is the one the code emits, and the doc may publish it.
		["packages/coding-agent/docs/acp.md", '    "ai.primeintellect.prime-agent": {', 0],
		["packages/coding-agent/docs/acp.md", "Prime Agent sends this", 1],
		[".gitignore", ".prime/agent/", 0],
		["src/a.ts", 'const id = "wasmedge-agent-traces";', 1],
		// The name of the file, with nothing in it. An image or a generated
		// module need not repeat its own name, and the two brand-asset patterns
		// exist to catch exactly this.
		["assets/brand/prime-logo.svg", "<svg/>", 1],
		["packages/coding-agent/src/themes/prime-butterfly.ts", "export const LOGO = [];", 1],
		["assets/brand/wasmedge-logo.svg", "<svg/>", 0],
		// Prime Inference's own modules keep their names; nothing here matches
		// a bare "prime".
		["packages/coding-agent/src/core/prime-inference-auth.ts", "export const X = 1;", 0],
		// Upstream's package identity, at a use site rather than in a manifest.
		// The install line in a README is the one a reader copies and runs.
		["README.md", "npm install @wasmedge/wasmedge-agent", 1],
		["README.md", "npm install -g @wasmedge-agent/coding-agent", 1],
		["src/a.ts", 'import { Agent } from "@earendil-works/wasmedge-agent-core";', 1],
		["README.md", "npm install @earendil-works/pi-coding-agent", 0],
		["src/a.ts", 'import type { Message } from "@earendil-works/pi-ai";', 0],
		// Our name, someone else's scope: a package nobody publishes, in the
		// line a reader copies and runs. Once each, not once per rule.
		["README.md", "npm install @other/pi-ai", 1],
		["src/a.ts", 'import { Tui } from "@acme-fork/pi-tui";', 1],
		["docs/x.md", "npm install @wasmedge/pi-coding-agent", 1],
		["tsconfig.json", '"@earendil-works/pi-agent-core": ["packages/agent/src"]', 0],
		// Upstream's own namespace under their own scope is not ours to police.
		["src/a.ts", 'import { thing } from "@mariozechner/pi-proxy";', 0],
		["src/a.ts", 'import { Tui } from "@mariozechner/pi-tui";', 0],
		// A case variant of each preserved wire family. Every one of these is
		// compared byte for byte at the other end, so the case that reads like
		// the product name is as broken as the lowercase spelling.
		["README.md", "id: WasmEdge-Agent-traces", 1],
		["docs/acp.md", "protocol: WASMEDGE-AGENT.daemon", 1],
		["docs/acp.md", 'toolCallId: "WasmEdge-Agent-bash-1"', 1],
		["docs/acp.md", 'meta: "ai.primeintellect.WasmEdge-Agent"', 1],
		["src/a.ts", 'type: "WasmEdge-Agent.worker_recovery"', 1],
		// The published fork command is not a package scope and is unaffected.
		["README.md", "curl -fsSL https://example.test/install.sh | sh -s -- wasmedge-agent", 0],
		// Case variants of the product name, which the case-sensitive patterns
		// let through in the surface a reader actually sees.
		["README.md", "Use Prime-Agent", 1],
		["README.md", "USE PRIME-AGENT", 1],
		["install.sh", "PRIME_Agent_screen_title=$1", 1],
		// A PI_* name taken into our namespace. The doc telling users to export
		// the new one is the case the pin cannot see: the old literal is still
		// in the source, so nothing is missing.
		["packages/coding-agent/README.md", "| `WASMEDGE_AGENT_OFFLINE` | Disable startup network |", 1],
		["src/a.ts", "if (process.env.WASMEDGE_AGENT_SKIP_VERSION_CHECK) return;", 1],
		["src/a.ts", "process.env.WASMEDGE_AGENT_TUI_LOG_DIR ??= getLogsDir();", 1],
		["src/a.ts", "process.env.PI_TUI_LOG_DIR ??= getLogsDir();", 0],
		// The name that was invisible while this was a list of PI_* suffixes to
		// forbid: nobody enumerated the example extension's marker.
		["src/a.ts", 'env: { ...env, WASMEDGE_AGENT_SPAWN_HOOK: "1" },', 1],
		// ...and a name nothing has ever been called, which the closed list
		// rejects on the same grounds: it is not ours until it is written down.
		["src/a.ts", "const x = process.env.WASMEDGE_AGENT_NEW_IDEA;", 1],
		// Registered names, including the ones that were PRIME_AGENT_* and share
		// a prefix with the rejected spellings above.
		["src/a.ts", "const dir = process.env.WASMEDGE_AGENT_CODING_AGENT_DIR;", 0],
		["src/a.ts", "const dir = process.env.WASMEDGE_AGENT_CODING_AGENT_SESSION_DIR;", 0],
		["src/a.ts", 'const pkg = readLegacyEnv("WASMEDGE_AGENT_PACKAGE");', 0],
		// Internal and test variables are ours by prefix: the spec renames them
		// outright, because no user sets them.
		["src/a.ts", "process.env.WASMEDGE_AGENT_INTERNAL_DAEMON_WORKER = \"1\";", 0],
		["src/a.ts", "process.env.WASMEDGE_AGENT_TEST_KEEP_ALIVE = \"1\";", 0],
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
		["src/a.ts", 'import { WASMEDGE_LOGO } from "./themes/wasmedge-logo.js";', 0],
		["src/a.ts", 'srcset="../../assets/brand/wasmedge-mark.svg"', 0],
		// The vendor name. Ours to fix wherever the subject is not the vendor --
		// this exact line shipped on the OAuth callback page rendered for every
		// Anthropic, OpenAI Codex and MCP login.
		["packages/ai/src/utils/oauth/oauth-page.ts", 'title: "Prime Intellect authentication successful",', 1],
		["src/a.ts", 'const label = "Sign in with Prime Intellect";', 1],
		// ...but a legal notice and the Prime Inference sign-in copy both have
		// Prime Intellect as their actual subject.
		["LICENSE", "Copyright (c) 2026 Prime Intellect", 0],
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
		// A legacy identifier in an Unreleased line is a violation until that
		// line has an entry of its own. The rename announcement's entry went
		// with the 0.0.1 cut; the released section it now sits in is history.
		[
			"packages/coding-agent/CHANGELOG.md",
			"# Changelog\n\n## [Unreleased]\n\n- `prime-agent` keeps working for one release.\n",
			1,
		],
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
	const foundRequired = new Set();
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
		for (const { literal, pathRe } of REQUIRED_RES) {
			if (!foundRequired.has(literal) && pathRe.test(path) && text.includes(literal)) {
				foundRequired.add(literal);
			}
		}
	}

	const stale = ALLOWLIST.filter((_, index) => !matchedAllow.has(index));
	const missing = REQUIRED.filter((entry) => !foundRequired.has(entry.literal));
	const failures = [
		...violations.map((v) => `${v.path}:${v.line} ${v.label} -- ${v.text}`),
		...stale.map((e) => `stale allowlist entry suppresses nothing: ${e.glob} (${e.reason})`),
		...missing.map((e) => `preserved value is gone from ${e.glob}: ${e.literal} (${e.why})`),
	];

	if (failures.length > 0) {
		console.error(["Branding check failed:", ...failures.map((f) => `- ${f}`)].join("\n"));
		process.exitCode = 1;
		return;
	}
	console.log(
		`check-branding: clean (${tracked.length} tracked files, ${ALLOWLIST.length} allowlist entries, ${REQUIRED.length} pinned values)`,
	);
}

main();
