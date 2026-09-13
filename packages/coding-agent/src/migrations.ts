/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import {
	cpSync,
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import {
	APP_NAME,
	forgetLegacyNameWarnings,
	getAgentDir,
	getBinDir,
	getProjectConfigDir,
	getSessionsDir,
	LEGACY_NAME_WARNINGS,
	withCurrentLegacyWarnings,
} from "./config.js";
import { migrateKeybindingsConfig } from "./core/keybindings.js";
import { legacyDaemonEndpoint } from "./modes/daemon/daemon-socket-dir.js";
import { readFirstLineSync } from "./utils/file-lines.js";

/** Windows lists its named pipes as a directory. Not a path we construct
 *  anything under -- it is only ever enumerated. */
const WINDOWS_PIPE_DIR = "\\\\.\\pipe\\";

const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Skip if auth.json already exists
	if (existsSync(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];

	// Migrate oauth.json
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(readFileSync(oauthPath, "utf-8"));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// Skip on error
		}
	}

	// Migrate settings.json apiKeys
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			}
		} catch {
			// Skip on error
		}
	}

	if (Object.keys(migrated).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	return providers;
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to the session root.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/. This migration moves them to the configured
 * session root.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const firstLine = readFirstLineSync(file);
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session") continue;

			const correctDir = getSessionsDir(agentDir);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const newPath = join(correctDir, basename(file));

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

function isSessionJsonlFile(filePath: string): boolean {
	try {
		const firstLine = readFirstLineSync(filePath);
		if (!firstLine?.trim()) {
			return false;
		}
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
		return header.type === "session" && typeof header.id === "string";
	} catch {
		return false;
	}
}

function isLegacySessionDirName(name: string): boolean {
	return /^--.+--$/.test(name);
}

/**
 * Migrate legacy per-cwd session directories into the flat session root.
 *
 * Older versions stored sessions under ~/.wasmedge-agent/sessions/--cwd--/*.jsonl.
 * The daemon list/continue paths now scan the flat session root, so move any
 * existing nested JSONL session files up one level.
 */
export function migrateLegacySessionDirsToSessionRoot(): void {
	const agentDir = getAgentDir();
	const sessionsDir = getSessionsDir(agentDir);

	let entries: Dirent[];
	try {
		entries = readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !isLegacySessionDirName(entry.name)) {
			continue;
		}

		const legacyDir = join(sessionsDir, entry.name);
		let files: string[];
		try {
			files = readdirSync(legacyDir).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const file of files) {
			const oldPath = join(legacyDir, file);
			let newPath = join(sessionsDir, file);
			if (!isSessionJsonlFile(oldPath)) {
				continue;
			}
			if (existsSync(newPath)) {
				if (filesHaveSameContent(oldPath, newPath)) {
					// Already migrated; leave the legacy copy alone.
					continue;
				}
				// A different session shares the basename; move it under a unique name
				// so it stays discoverable by the flat-root list and continue paths.
				newPath = uniqueSessionRootPath(sessionsDir, file);
			}
			try {
				renameSync(oldPath, newPath);
			} catch {
				// Leave the legacy file in place if it cannot be moved.
			}
		}

		try {
			if (readdirSync(legacyDir).length === 0) {
				rmdirSync(legacyDir);
			}
		} catch {
			// Ignore cleanup errors; migrated files are already in the flat root.
		}
	}
}

function filesHaveSameContent(a: string, b: string): boolean {
	try {
		if (statSync(a).size !== statSync(b).size) {
			return false;
		}
		return readFileSync(a, "utf-8") === readFileSync(b, "utf-8");
	} catch {
		return false;
	}
}

function uniqueSessionRootPath(sessionsDir: string, file: string): string {
	const base = file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : file;
	for (let n = 1; ; n++) {
		const candidate = join(sessionsDir, `${base}-${n}.jsonl`);
		if (!existsSync(candidate)) {
			return candidate;
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = getProjectConfigDir(cwd);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 *
 * Records what it showed, in the same set the terse counterpart records into.
 * That set is the run's delivery log, and it is what resetReportedLegacyWarnings
 * consults to decide which warnings belong to a run that has finished -- so a
 * warning delivered only through this channel, and never written down, survived
 * into an embedder's next call to main() and was shown again with the condition
 * that caused it already gone. It also stops this channel and a later drain in
 * the same run from saying the same thing twice.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		reportedLegacyWarnings.add(warning);
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	if (!process.stdin.isTTY) {
		// A non-interactive parent never delivers the keypress; don't hang waiting for it.
		console.log();
		return;
	}
	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Terse, non-blocking counterpart to showDeprecationWarnings for
 * non-interactive modes (--print, --json, rpc, acp, daemon). The interactive
 * channel above blocks on a keypress inside the TUI's alternate screen; a
 * scripted invocation has no keypress to wait for and no alternate screen to
 * write into, so without this a user running any non-interactive mode with a
 * legacy env var set gets the correct fallback but is never told it is
 * deprecated -- exactly the population most likely to have set one, and
 * exactly the population least likely to notice removal until it breaks.
 *
 * The caller supplies the writer: stdout is a protocol surface for
 * --mode acp, rpc, and --json, whose contract test pins a single JSON
 * document, so this must never reach it.
 */
/** Deprecation warnings already written to stderr in this run.
 *
 *  LEGACY_NAME_WARNINGS dedups by exact string on push, so it never holds a
 *  duplicate -- but that says nothing about reading it twice, and the drains
 *  below run at several points in one run: an early-return command, theme
 *  initialisation, and each of the config command's two exits. Without this
 *  set the second drain would reprint everything the first one wrote.
 *
 *  Lives here rather than in main() because the config command exits the
 *  process itself, from two places, and has to drain through the same
 *  bookkeeping main() uses. */
const reportedLegacyWarnings = new Set<string>();

/** Per run of main(), matching resetTimings(): an embedder calling main()
 *  twice gets the reporting two processes would.
 *
 *  Both halves of the bookkeeping, because they are one fact split in two.
 *  Forgetting that a warning was written, while leaving the warning itself in
 *  a collection that outlives the run, is what made the second run reprint the
 *  first run's warnings with nothing left to justify them. Only the delivered
 *  ones go: see forgetLegacyNameWarnings() for the warning that the process
 *  entry point collects before main() exists and nothing can re-derive. */
export function resetReportedLegacyWarnings(): void {
	forgetLegacyNameWarnings(reportedLegacyWarnings);
	reportedLegacyWarnings.clear();
}

/** Writes the warnings this run has not written yet, to stderr. */
/** How many EAGAIN retries a startup warning is worth.
 *
 *  Reached only when stderr is a non-blocking descriptor whose reader has
 *  stopped consuming, and the whole payload is a few short lines against a
 *  pipe buffer of tens of kilobytes -- so this is a bound on a case that does
 *  not arise rather than a retry policy anything relies on. Bounded anyway,
 *  because the alternative is a startup that spins instead of ending. */
const STDERR_RETRY_LIMIT = 1000;

/** Writes to stderr in a way that survives the process.exit() that follows it.
 *
 *  process.stderr is a stream, and Node only promises its writes are
 *  synchronous for some combinations of platform and destination: a pipe is
 *  synchronous on Linux but asynchronous on macOS, and a TTY is the other way
 *  round on Windows. process.exit() does not drain what is still buffered, so
 *  on the asynchronous combinations the startup exits that call this lost some
 *  or all of the deprecation warnings they exist to deliver -- and lost them
 *  exactly when the output was redirected or captured, which is the case least
 *  able to notice and most likely to be a script someone is relying on.
 *
 *  A write on the descriptor bypasses the stream, so the bytes are gone before
 *  the call returns and there is nothing left for the exit to abandon. It can
 *  write short, and on a non-blocking descriptor it can fail with EAGAIN, so
 *  it loops on both. The descriptor is read off process.stderr rather than
 *  hardcoded as 2, so a caller that has redirected the stream is still writing
 *  where the stream points.
 *
 *  Anything else falls back to the stream: a warning that might not survive an
 *  immediate exit still beats no warning at all.
 *
 *  Exported because the legacy-command notice has the same problem from a
 *  different writer: warnIfLegacyAlias takes the writer it is given, and the
 *  early-return commands print and exit the same way the startup exits do. */
export function writeStderrSync(message: string): void {
	const bytes = Buffer.from(message, "utf8");
	let written = 0;
	let retries = 0;
	while (written < bytes.length) {
		try {
			written += writeSync(process.stderr.fd, bytes, written);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EAGAIN" && retries++ < STDERR_RETRY_LIMIT) continue;
			process.stderr.write(bytes.subarray(written).toString("utf8"));
			return;
		}
	}
}

export function reportStartupWarnings(warnings: readonly string[]): void {
	const pending = warnings.filter((warning) => !reportedLegacyWarnings.has(warning));
	for (const warning of pending) reportedLegacyWarnings.add(warning);
	reportDeprecationWarningsNonInteractively(pending, writeStderrSync);
}

/** Reports every legacy-name warning collected so far, wherever a command is
 *  about to end without reaching the mode-level reporter. Derived from
 *  LEGACY_NAME_WARNINGS at the moment of the call rather than from a snapshot,
 *  so a name the command itself consumed while running is included. */
export function drainLegacyNameWarnings(): void {
	reportStartupWarnings(withCurrentLegacyWarnings([]));
}

export function reportDeprecationWarningsNonInteractively(
	warnings: readonly string[],
	write: (message: string) => void,
): void {
	for (const warning of warnings) {
		write(`Warning: ${warning}\n`);
	}
}

/**
 * Move ~/.prime/agent to ~/.wasmedge-agent exactly once.
 *
 * Takes both paths as parameters rather than reading homedir() internally: a
 * test can redirect the destination through ENV_AGENT_DIR, but redirecting
 * the source would otherwise mean mutating $HOME and relying on Node's POSIX
 * os.homedir() consulting it -- a load-bearing detail buried in a test.
 *
 * Never merges and never clobbers. When both directories exist the user has
 * already migrated or deliberately created the new one, so the legacy tree is
 * left exactly as found; no data can be lost to a wrong guess.
 *
 * That case is reported as `bothPresent`, distinct from the plain "nothing to
 * do" of a missing legacy directory. The two are not interchangeable: a user
 * whose configuration, credentials and sessions all live in the legacy tree
 * while the agent silently reads an empty new one sees a first-run experience
 * with no explanation, and the caller can only say so if this function tells
 * it which of the two happened. The installer manufactures exactly that state
 * -- `npm install -g` runs postinstall, which creates the managed-binaries
 * directory under the new path -- so it is the common case, not a corner one.
 */
export interface AgentDirMigrationResult {
	moved: boolean;
	from?: string;
	/** Both directories exist, so nothing was moved and `targetDir` is in use. */
	bothPresent?: boolean;
	/** The move was attempted and threw, so the legacy tree still holds the
	 *  configuration and `targetDir` does not exist yet.
	 *
	 *  Distinct from a plain `{ moved: false }`, which means there was nothing
	 *  to move. Only after a failure does creating `targetDir` cost anything,
	 *  and only the caller knows whether the work it is about to do is worth
	 *  that cost -- see migrateAgentDirIfNeeded's catch block. */
	failed?: boolean;
}

export function migrateAgentDirToWasmEdge(legacyDir: string, targetDir: string): AgentDirMigrationResult {
	if (legacyDir === targetDir) return { moved: false };
	if (!existsSync(legacyDir)) return { moved: false };
	if (existsSync(targetDir)) return { moved: false, bothPresent: true };

	mkdirSync(dirname(targetDir), { recursive: true });
	try {
		renameSync(legacyDir, targetDir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" && !existsSync(legacyDir) && existsSync(targetDir)) {
			// Another process moved it between our check and this call. Every
			// spawned daemon worker runs this, so the race is routine, and the
			// check-then-act is not atomic -- it must not pretend to be.
			//
			// Only this state counts as that race, and it is checked rather
			// than assumed: the source gone and the target present is what a
			// completed move leaves behind. ENOENT also means a component of
			// either path was unreachable -- an unmounted parent, a home
			// directory pulled out from under us -- and there nothing moved
			// while the legacy tree still holds the user's configuration,
			// credentials and sessions. Reporting that as "nothing to do"
			// starts the agent on an empty directory in silence, which is the
			// one outcome the caller's warning exists to prevent, so it falls
			// through to the throw below and the caller retries next launch.
			return { moved: false };
		}
		if (code === "EXDEV") {
			// Different filesystems. Copy first and only remove the source once
			// the copy is verified, so an interrupted move loses nothing.
			//
			// The copy lands in a sibling staging directory and is renamed into
			// place, rather than being written straight into targetDir. cpSync
			// can fail part way through -- ENOSPC, one unreadable file -- and a
			// half-written targetDir would then satisfy the existsSync(targetDir)
			// early return above on every later launch: the caller warns once,
			// and the retry that warning promises can never happen again while
			// the preserved legacy tree goes unread forever. Staging keeps the
			// failure retryable, and the final rename is same-directory, so it
			// cannot itself hit EXDEV.
			//
			// verbatimSymlinks, because this copy is one half of a move: it has
			// to reproduce the tree as it is, not as it resolves from a place
			// that is about to stop existing. Node's default resolves a relative
			// symlink target against the source and writes it back as an
			// absolute path, so a link pointing inside the tree comes out
			// pointing into the legacy directory -- which the rmSync below then
			// deletes, leaving every such link in the migrated tree dangling.
			// These links are not hypothetical: migrateCommandsToPrompts renames
			// commands/ to prompts/ and documents that it works on symlinks,
			// because users link extension directories into a checked-out
			// repository.
			const stagingDir = `${targetDir}.migrating-${process.pid}`;
			rmSync(stagingDir, { recursive: true, force: true });
			try {
				cpSync(legacyDir, stagingDir, { recursive: true, verbatimSymlinks: true });
				renameSync(stagingDir, targetDir);
			} catch (copyError) {
				rmSync(stagingDir, { recursive: true, force: true });
				throw copyError;
			}
			if (!existsSync(targetDir)) return { moved: false };
			rmSync(legacyDir, { recursive: true, force: true });
			return { moved: true, from: legacyDir };
		}
		throw error;
	}
	return { moved: true, from: legacyDir };
}

/** Removes the legacy directory's parent once the agent directory has moved
 *  out of it, so an upgraded machine is not left with an empty ~/.prime next
 *  to the ~/.wasmedge-agent that replaced it.
 *
 *  Only when it is genuinely empty. ~/.prime is not ours: Prime Inference
 *  keeps its own credentials in ~/.prime/config.json, at exactly this path,
 *  and that file is the provider's and survives the rebrand untouched. Any
 *  entry at all -- that one included -- means the directory still has an
 *  owner, so it stays. */
function removeLegacyParentIfEmpty(legacyParentDir: string): void {
	try {
		if (readdirSync(legacyParentDir).length > 0) return;
		rmdirSync(legacyParentDir);
	} catch {
		// Gone already, or not ours to remove. An empty directory left behind
		// is untidy, never harmful, so nothing here is worth failing over.
	}
}

/** True when a daemon from the release before the rename may still be holding
 *  `endpoint`.
 *
 *  Presence, not liveness -- and it cannot become liveness here.
 *  migrateAgentDirIfNeeded() runs synchronously at process entry, in
 *  cli-main.ts, postinstall.ts and main.ts, before anything may resolve the
 *  agent directory, and Node has no synchronous connect for a unix socket. So
 *  a socket file left behind by an unclean shutdown is indistinguishable from
 *  a live daemon. Do not read the result as a liveness check.
 *
 *  Windows is the exception, and is stronger rather than weaker: a named pipe
 *  has no file to stat, but it appears in the pipe directory listing only
 *  while a server holds it open, so there the check is closer to liveness than
 *  to presence.
 *
 *  Both branches degrade to false. A directory listing is not guaranteed on
 *  every Windows configuration, and neither branch may throw: this runs before
 *  the application has started, and a failure to look must cost a warning, not
 *  the process.
 *
 *  `platform` and `pipeDir` are parameters so both branches can be covered
 *  from either host. Nothing passes them outside the tests. */
export function legacyDaemonEndpointPresent(
	endpoint: string,
	platform: NodeJS.Platform = process.platform,
	pipeDir: string = WINDOWS_PIPE_DIR,
): boolean {
	if (platform === "win32") {
		// Split on the separator rather than using basename(): a test drives
		// this branch from a POSIX host, where basename() does not treat a
		// backslash as one and would compare the whole endpoint.
		const pipeName = endpoint.slice(endpoint.lastIndexOf("\\") + 1).toLowerCase();
		try {
			return readdirSync(pipeDir).some((entry) => entry.toLowerCase() === pipeName);
		} catch {
			return false;
		}
	}
	try {
		return lstatSync(endpoint).isSocket();
	} catch {
		// Nothing there, or nothing we may look at.
		return false;
	}
}

/** Queues the warning for a daemon left over from the release before the
 *  rename, given what the move ended up doing.
 *
 *  Why this matters. That daemon holds absolute paths under the legacy agent
 *  directory, and this build cannot reach it: the endpoint moved with the
 *  name, so the new client looks somewhere else and starts a daemon of its
 *  own. The old one's next write then repopulates the legacy directory with
 *  session state nothing here will read again.
 *
 *  Why the migration still happens, which is settled and should not be
 *  reopened:
 *
 *  - The check above is presence, not liveness, and cannot become liveness at
 *    process entry. A socket file left by an unclean shutdown looks exactly
 *    like a running daemon.
 *  - So refusing to migrate turns that false positive into a hard failure. In
 *    the CLI the agent would refuse to start, and the remedy would be deleting
 *    a socket file the user does not know exists. In postinstall.ts,
 *    `npm install -g` would fail outright. Both are worse than the divergence
 *    they prevent, and both are reachable by accident.
 *  - The failure mode as it stands is bounded and reported: nothing is
 *    destroyed, the legacy tree keeps whatever the old daemon writes next, and
 *    the next launch finds both directories and says so.
 *
 *  Stopping the daemon is not this code's to do either. It is a process the
 *  user owns, and one of the three callers is a package postinstall script.
 *
 *  The text describes the state as it is once this returns, because that is
 *  when a human can read it: the queue is drained by a reporter much later,
 *  well after the move. Promising a window to act before the move would be a
 *  window that does not exist.
 *
 *  Routed through LEGACY_NAME_WARNINGS for the same reason the
 *  both-directories warning is: it is the one deprecation channel every mode
 *  already drains, and it never reaches stdout, which is a protocol surface
 *  for --mode acp, rpc and --json. */
function queueLegacyDaemonWarning(endpoint: string, legacyDir: string, targetDir: string, moved: boolean): void {
	const state = moved
		? `Your configuration has moved to ${targetDir}.`
		: `${targetDir} is the configuration directory in use now.`;
	const warning =
		`${state} A daemon from the previous release may still be running on ${endpoint}, ` +
		`and this build cannot reach it; until you stop it, it can write session state into ` +
		`${legacyDir}, which is no longer read. Stop it and start ${APP_NAME} again.`;
	if (!LEGACY_NAME_WARNINGS.includes(warning)) LEGACY_NAME_WARNINGS.push(warning);
}

/** Wire-up for the one-time config directory move. Separate from
 *  runMigrations because it must precede the logger, which resolves the agent
 *  directory lazily on its first write. */
export function migrateAgentDirIfNeeded(): AgentDirMigrationResult {
	const legacyDir = join(homedir(), ".prime", "agent");
	const targetDir = getAgentDir();
	// Read before the move, because the move is what makes the old daemon's
	// paths stale: this has to record the endpoint as it was when the process
	// started, not as it looks once this function has already changed what the
	// old daemon is pointing at. The warning itself is composed afterwards, so
	// it can describe what actually happened -- nobody reads it before then,
	// because the queue is drained by a reporter much later.
	const legacyEndpoint = legacyDaemonEndpoint();
	const legacyDaemonPresent = legacyDaemonEndpointPresent(legacyEndpoint);
	try {
		const result = migrateAgentDirToWasmEdge(legacyDir, targetDir);
		if (result.bothPresent) {
			// The never-clobber rule is correct but silent, and silence here reads
			// as data loss: the legacy tree still holds the user's auth, sessions
			// and settings while the agent starts from an empty new directory.
			// Routed through LEGACY_NAME_WARNINGS rather than a console write of
			// its own so it drains through the one deprecation channel every mode
			// already renders -- the blocking interactive one and the terse
			// stderr counterpart alike -- and never onto stdout, which is a
			// protocol surface for --mode acp, rpc and --json.
			const warning =
				`${legacyDir} and ${targetDir} both exist, so nothing was migrated. ` +
				`${targetDir} is the one in use; ${legacyDir} is ignored. ` +
				`Move anything you still need out of ${legacyDir} and delete it.`;
			if (!LEGACY_NAME_WARNINGS.includes(warning)) LEGACY_NAME_WARNINGS.push(warning);
		}
		if (result.moved) removeLegacyParentIfEmpty(dirname(legacyDir));
		if (legacyDaemonPresent) queueLegacyDaemonWarning(legacyEndpoint, legacyDir, targetDir, result.moved);
		return result;
	} catch (error) {
		// The move runs as the first statement of main(), so an error that
		// propagated from here would stop the application from starting at all --
		// a file the old daemon still holds open on Windows (EPERM) or an
		// unreadable directory (EACCES) is enough. Absorb it here rather than
		// weakening migrateAgentDirToWasmEdge, whose selective catch is the point:
		// the legacy tree is left exactly as it was, and the move is idempotent,
		// so the next launch retries it. A warning plus a fresh config directory
		// beats a binary that will not run.
		//
		// That retry has one condition, and reporting `failed` rather than
		// folding it into the plain `{ moved: false }` is what lets a caller
		// honour it: the retry survives only while targetDir stays absent,
		// because the never-clobber rule refuses the move once both directories
		// exist. Whatever creates targetDir first therefore decides that the
		// legacy tree is never read again. postinstall.ts is the caller that can
		// create it with no user watching -- `npm install -g` with the
		// installer's tool bootstrap enabled -- so it reads this flag and stops
		// before its bootstrap work.
		//
		// stderr, not stdout: stdout is a protocol surface for --mode acp, rpc
		// and --json, and a warning written there would corrupt the stream.
		console.error(
			chalk.yellow(
				`Warning: could not move ${legacyDir} to ${targetDir}: ${error instanceof Error ? error.message : error}\n` +
					`Continuing with ${targetDir}. Your existing configuration is untouched in ${legacyDir}, and the move is retried on the next launch -- but only for as long as ${targetDir} does not exist. Once it does, move what you still need out of ${legacyDir} yourself.`,
			),
		);
		return { moved: false, failed: true };
	}
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateLegacySessionDirsToSessionRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	// migrateExtensionSystem() must run, and its return value must be captured,
	// before LEGACY_NAME_WARNINGS is spread below: it calls getProjectConfigDir(cwd)
	// internally, which can push a fresh warning. Array-literal spread elements
	// evaluate left to right, so inlining the call as the second spread operand
	// -- [...LEGACY_NAME_WARNINGS, ...migrateExtensionSystem(cwd)] -- would read
	// LEGACY_NAME_WARNINGS before that push ever happens and silently drop the
	// warning. This bit the session-dir warning once already (commit 51696c37).
	const extensionWarnings = migrateExtensionSystem(cwd);
	const deprecationWarnings = [...LEGACY_NAME_WARNINGS, ...extensionWarnings];
	return { migratedAuthProviders, deprecationWarnings };
}
