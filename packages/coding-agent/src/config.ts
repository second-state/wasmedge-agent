import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
	accessSync,
	appendFileSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { shouldUseWindowsShell } from "./utils/child-process.js";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

export const SELF_UPDATE_INTERACTIVE_CHILD_ENV = "WASMEDGE_AGENT_INTERACTIVE_SELF_UPDATE";
export const SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE = 75;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string;
}

export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
	options: { uninstallAfterInstall?: boolean } = {},
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	if (options.uninstallAfterInstall) {
		return {
			...installStep,
			display: `${installStep.display} && ${uninstallStep.display}`,
			steps: [installStep, uninstallStep],
		};
	}
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	const packageDir = getPackageDir();
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	const parent = path.dirname(packageDir);
	let root: string | undefined;
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		root = path.dirname(parent);
	} else if (path.basename(parent) === "node_modules") {
		root = parent;
	}
	if (!root) return undefined;
	const rootParent = path.dirname(root);
	if (path.basename(rootParent) === "lib") return { root, prefix: path.dirname(rootParent) };
	// Windows global npm prefixes use `<prefix>\\node_modules`, which is
	// indistinguishable from local project installs by path shape alone. Do not
	// infer unsupported Windows custom prefixes without `npm root -g` evidence.
	return undefined;
}

function isDirectPackageArtifactSpec(updateSpec: string): boolean {
	const spec = updateSpec.trim().toLowerCase();
	return (
		spec.startsWith("http://") ||
		spec.startsWith("https://") ||
		spec.startsWith("file:") ||
		spec.endsWith(".tgz") ||
		spec.endsWith(".tar.gz")
	);
}

function getDefaultUpdatePackageName(installedPackageName: string, updateSpec: string): string {
	if (isDirectPackageArtifactSpec(updateSpec)) {
		return installedPackageName;
	}
	return updateSpec;
}

function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updateSpec = installedPackageName,
	npmCommand?: string[],
	updatePackageName = getDefaultUpdatePackageName(installedPackageName, updateSpec),
): SelfUpdateCommand | undefined {
	const uninstallAfterInstall = isDirectPackageArtifactSpec(updateSpec);
	switch (method) {
		case "bun-binary":
			return undefined;
		case "pnpm":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", ["install", "-g", updateSpec]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", updateSpec]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", ["install", "-g", updateSpec]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "npm": {
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			const installStep = makeSelfUpdateCommandStep(command, [...prefixArgs, "install", "-g", updateSpec]);
			const uninstallStep =
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			return makeSelfUpdateCommand(installStep, uninstallStep, { uninstallAfterInstall });
		}
		case "unknown":
			return undefined;
	}
}

function readCommandOutput(
	command: string,
	args: string[],
	options: { requireSuccess?: boolean } = {},
): string | undefined {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		shell: shouldUseWindowsShell(command),
	});
	if (result.status === 0) return result.stdout.trim() || undefined;
	if (options.requireSuccess) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	return undefined;
}

function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	switch (method) {
		case "npm": {
			const configured = !!npmCommand?.length;
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			if (configured && command === "bun") {
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					requireSuccess: true,
				});
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				if (bunBin) {
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				return roots;
			}
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				requireSuccess: configured,
			});
			const inferred = configured ? undefined : getInferredNpmInstall();
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			return root ? [root, dirname(root)] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "unknown":
			return [];
	}
}

function normalizeExistingPathForComparison(path: string): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath: string;
	try {
		normalizedPath = realpathSync(resolvedPath);
	} catch {
		return undefined;
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

function isSelfUpdatePathWritable(): boolean {
	const packageDir = getPackageDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	const packageDir = normalizeExistingPathForComparison(getPackageDir());
	return (
		!!packageDir &&
		getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
			const normalizedRoot = normalizeExistingPathForComparison(root);
			return (
				!!normalizedRoot &&
				packageDir.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`)
			);
		})
	);
}

export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updateSpec = packageName,
	updatePackageName = getDefaultUpdatePackageName(packageName, updateSpec),
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName, updateSpec, npmCommand, updatePackageName);
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updateSpec = packageName,
	updatePackageName = getDefaultUpdatePackageName(packageName, updateSpec),
): string {
	const method = detectInstallMethod();
	if (method === "bun-binary") {
		return `Download from: https://github.com/hydai/wasmedge-agent/releases/latest`;
	}
	const command = getSelfUpdateCommandForMethod(method, packageName, updateSpec, npmCommand, updatePackageName);
	if (command) {
		if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${updateSpec} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

/**
 * Get the directory containing built-in skills shipped with the package.
 * - For Bun binary: skills/ next to executable
 * - For Node.js (dist/): dist/skills/
 * - For tsx (src/): skills/ at the package root
 */
export function getBundledSkillsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "skills");
	}
	const packageDir = getPackageDir();
	// Source checkouts (tsx) keep built-in skills at the package root; built
	// packages copy them to dist/skills. Decide by whether src/ is present so a
	// stale dist/ from a prior build never shadows live source edits.
	const isSourceCheckout = existsSync(join(packageDir, "src"));
	return isSourceCheckout ? join(packageDir, "skills") : join(packageDir, "dist", "skills");
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;

const piConfigName: string | undefined = pkg.piConfig?.name;
const envPrefix =
	(piConfigName || "pi")
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "") || "PI";
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".prime/agent";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., PI_CODING_AGENT_DIR or WASMEDGE_AGENT_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${envPrefix}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${envPrefix}_SESSION_DIR`;
export const ENV_LEGACY_SESSION_DIR = `${envPrefix}_CODING_AGENT_SESSION_DIR`;

/** User-facing variables that keep a PRIME_AGENT_* fallback for one release.
 *  Every name here has a real call site routed through readLegacyEnv (or,
 *  for install.sh's own copies, the shell-side fallback next to
 *  wasmedge_agent_warn_if_legacy_env) -- this table is a contract, not a wish
 *  list, so a name with no reachable reader does not belong here.
 *
 *  Internal (*_INTERNAL_*) and test (*_TEST_*) variables are renamed
 *  outright, following the WP8 precedent: no user sets them.
 *  WASMEDGE_AGENT_INTERACTIVE_SELF_UPDATE is renamed outright for the same
 *  reason despite not matching that naming pattern, and this is deliberate
 *  rather than an oversight: it is a relaunch signal that interactive-mode.ts
 *  writes into the environment of a child it spawns from process.execPath and
 *  the current entrypoint, and that package-manager-cli.ts and
 *  public-command.ts read back inside that child. Both ends are the same
 *  build by construction, so no old binary's name is ever presented to a new
 *  one and a fallback here could never fire. Adding one back would be dead
 *  code, not compatibility.
 *  PRIME_API_KEY is absent on purpose -- it belongs to Prime Inference, not
 *  to us. */
const LEGACY_ENV_NAMES: ReadonlyArray<string> = [
	"CODING_AGENT_DIR",
	"SESSION_DIR",
	"CODING_AGENT_SESSION_DIR",
	"DOWNLOAD_BASE_URL",
	"RELEASE_CHANNEL",
	"PACKAGE",
	"CMD",
	"INSTALLER_PLAIN",
	"SHELL_PROFILE",
	"VERSION",
	"BOOTSTRAP_TOOLS_ON_INSTALL",
	"TRACES_API_KEY",
	"TRACES_BASE_URL",
	"WEBSEARCH_NUM_RESULTS",
	"WEBSEARCH_TIMEOUT",
];

/** Collected during startup and drained through the existing deprecation
 *  channel in migrations.ts, so no new surfacing mechanism appears. Carries
 *  both env-name and project-path deprecations (Task 6 appends to it too). */
export const LEGACY_NAME_WARNINGS: string[] = [];

/**
 * Unions a deprecationWarnings snapshot (e.g. runMigrations()'s return value)
 * with the current LEGACY_NAME_WARNINGS, deduped by exact string.
 *
 * A long startup sequence can push a fresh warning well after that snapshot
 * was taken -- --resume may pick a session whose cwd differs from the one
 * runMigrations(cwd) ran against, and settings/resource resolution against
 * that final cwd can call getProjectConfigDir() on a directory the snapshot
 * never saw. Re-deriving the display list from LEGACY_NAME_WARNINGS at
 * display time, instead of reusing only the stale snapshot, catches that
 * case. Deduping by exact string (the same rule every push already uses)
 * guarantees this can never double up an entry the snapshot already carried.
 */
export function withCurrentLegacyWarnings(snapshot: readonly string[]): string[] {
	return Array.from(new Set([...snapshot, ...LEGACY_NAME_WARNINGS]));
}

export function readLegacyEnv(name: string): string | undefined {
	const current = process.env[name];
	if (current !== undefined) return current;

	const prefix = `${envPrefix}_`;
	if (!name.startsWith(prefix)) return undefined;
	const suffix = name.slice(prefix.length);
	if (!LEGACY_ENV_NAMES.includes(suffix)) return undefined;

	const legacyName = `PRIME_AGENT_${suffix}`;
	const legacy = process.env[legacyName];
	if (legacy === undefined) return undefined;

	const warning = `${legacyName} is deprecated; use ${name}. The old name stops working after the next release.`;
	if (!LEGACY_NAME_WARNINGS.includes(warning)) LEGACY_NAME_WARNINGS.push(warning);
	return legacy;
}

/** Set by the entry point the release installs at the legacy command name,
 *  and consumed by warnIfLegacyAlias below.
 *
 *  argv[1] is not enough on its own. npm links a POSIX command by symlinking
 *  the name at its target, so the basename there really is the name the user
 *  typed -- but on Windows npm generates `.cmd` and PowerShell shims that
 *  launch node with the *target* path, and the invoked name is nowhere in the
 *  child's argv. Without this the alias runs on Windows without ever warning,
 *  which quietly removes the one-release deprecation notice on that platform.
 *  scripts/pack-wasmedge-agent-release.mjs writes the entry point that sets
 *  it; its covering test asserts the two spellings match. */
export const LEGACY_ALIAS_ENV = "WASMEDGE_AGENT_LEGACY_ALIAS";

/** Deprecation notice for the legacy command name, or undefined.
 *  The caller supplies the writer: stdout is a protocol surface for
 *  --mode acp, rpc, and --json, whose contract test pins a single JSON
 *  document, so this must never reach it. */
export function warnIfLegacyAlias(invokedAs: string, write: (message: string) => void): boolean {
	// Read and delete together, before anything can decide not to warn: every
	// child this process spawns inherits process.env -- daemon workers, owned
	// session workers, an update relaunch -- and each of them runs this same
	// code, so a marker left in place repeats the notice once per child for a
	// command the user typed once.
	const invokedThroughAliasShim = process.env[LEGACY_ALIAS_ENV] !== undefined;
	delete process.env[LEGACY_ALIAS_ENV];
	if (!invokedThroughAliasShim && basename(invokedAs) !== "prime-agent") return false;
	write(
		"warning: 'prime-agent' is deprecated; use 'wasmedge-agent'. " +
			"The alias stops working after the next release.\n",
	);
	return true;
}

export function expandTildePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return homedir() + path.slice(1);
	return path;
}

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.wasmedge-agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.wasmedge-agent/) */
export function getAgentDir(): string {
	const envDir = readLegacyEnv(ENV_AGENT_DIR);
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME);
}

/** Project-local config directory, with a one-release fallback to the legacy
 *  name. Project directories live inside users' own repositories, so unlike
 *  the home directory we cannot migrate them -- we can only keep reading
 *  them. Resolved per call rather than cached: cwd changes between sessions
 *  and the directory can appear while the process runs. */
export function getProjectConfigDir(cwd: string): string {
	const current = join(cwd, CONFIG_DIR_NAME);
	if (existsSync(current)) return current;

	const legacy = join(cwd, ".prime", "agent");
	if (existsSync(legacy)) {
		const warning = `${legacy} is deprecated; rename it to ${CONFIG_DIR_NAME}. The old name stops working after the next release.`;
		if (!LEGACY_NAME_WARNINGS.includes(warning)) LEGACY_NAME_WARNINGS.push(warning);
		return legacy;
	}
	return current;
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Directory where daemon and client diagnostic logs are written (e.g. ~/.wasmedge-agent/logs/). */
export function getLogsDir(): string {
	return join(getAgentDir(), "logs");
}

/** Log file capturing client-side agent-open failures. */
export function getClientErrorLogPath(): string {
	return join(getLogsDir(), "client-errors.log");
}

export function getAgentTracesLogPath(): string {
	return join(getLogsDir(), "agent-traces.log");
}

/** Shared structured (JSON lines) log for client, daemon, and provider diagnostics. */
export function getAgentLogPath(): string {
	return join(getLogsDir(), "agent.jsonl");
}

/**
 * Log file for a daemon. The basename keeps it readable; a hash of the full
 * socket path makes it unique so two sockets that share a basename (e.g.
 * daemon.sock in different dirs) don't interleave into one file.
 */
export function getDaemonLogPath(socketPath: string): string {
	const hash = createHash("sha256").update(socketPath).digest("hex").slice(0, 8);
	return join(getLogsDir(), `${basename(socketPath)}.${hash}.log`);
}

export function getDaemonUpdateRestartManifestPath(socketPath: string, agentDir: string = getAgentDir()): string {
	const normalizedSocketPath = process.platform === "win32" ? socketPath.toLowerCase() : resolve(socketPath);
	const socketHash = createHash("sha256").update(normalizedSocketPath).digest("hex");
	return join(agentDir, "daemon-update-restarts", `${socketHash}.json`);
}

export function getLegacyDaemonUpdateRestartManifestPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "daemon-update-restart.json");
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Append a line to a log file, keeping its size bounded with a single-generation
 * rotation. Opens and closes per call (no held fd), so rotation works at runtime
 * — a long-lived writer rotates on the write that crosses the cap, not only at
 * startup. Best-effort: diagnostics must never throw into the caller.
 */
export function appendRotatingLog(logPath: string, message: string, maxBytes: number = MAX_LOG_BYTES): void {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		try {
			if (existsSync(logPath) && statSync(logPath).size > maxBytes) {
				// Drop any prior .old first: renameSync fails on Windows if it exists.
				rmSync(`${logPath}.old`, { force: true });
				renameSync(logPath, `${logPath}.old`);
			}
		} catch {
			// Keep appending rather than dropping the log on a rotation failure.
		}
		appendFileSync(logPath, `${message}\n`);
	} catch {
		// A read-only or missing log dir must never break the caller.
	}
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to cron jobs store */
export function getCronJobsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "cron-jobs.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(agentDir: string = getAgentDir()): string {
	const envDir = getSessionDirEnvOverride();
	if (envDir) {
		return envDir;
	}
	return join(agentDir, "sessions");
}

/** The session root from the environment, if any variable names one.
 *
 *  Both current names resolve before either compatibility fallback, and that
 *  ordering is the whole point. Resolving each pair in turn -- the short name
 *  and its PRIME_AGENT_* fallback, then the long name and its own -- put
 *  PRIME_AGENT_SESSION_DIR ahead of WASMEDGE_AGENT_CODING_AGENT_SESSION_DIR,
 *  so an upgraded environment that still exported the old short name went on
 *  using the old directory after the user had set a current variable and had
 *  every reason to think it took effect. A name we are asking people to stop
 *  using cannot outrank one we are asking them to use.
 *
 *  Within each half the short name still wins, which is the precedence that
 *  predates the rebrand and is not what changed here. */
export function getSessionDirEnvOverride(): string | undefined {
	const envDir =
		process.env[ENV_SESSION_DIR] ??
		process.env[ENV_LEGACY_SESSION_DIR] ??
		readLegacyEnv(ENV_SESSION_DIR) ??
		readLegacyEnv(ENV_LEGACY_SESSION_DIR);
	return envDir ? expandTildePath(envDir) : undefined;
}

/**
 * Forces every legacy-aware getter -- env vars and the project-local config
 * directory alike -- to resolve once, so any PRIME_AGENT_* or legacy
 * project-directory fallback it finds lands in LEGACY_NAME_WARNINGS before
 * runMigrations snapshots that array into deprecationWarnings.
 *
 * getAgentDir() already runs this early via migrateAgentDirIfNeeded(), and
 * migration steps inside runMigrations happen to call getSessionDirEnvOverride()
 * (via getSessionsDir(), for an unrelated reason: finding legacy per-cwd
 * session directories to migrate) and getProjectConfigDir(cwd) (via
 * migrateExtensionSystem(), for the unrelated commands->prompts migration)
 * too -- but relying on either incidental call is exactly the kind of
 * accident this compatibility window must not depend on. A refactor of
 * either migration step that skips or reorders its call would silently stop
 * that warning from ever reaching deprecationWarnings, in every mode, with
 * nothing to catch it. (This is not hypothetical: runMigrations' own
 * deprecationWarnings assembly once read LEGACY_NAME_WARNINGS via array
 * spread -- `[...LEGACY_NAME_WARNINGS, ...migrateExtensionSystem(cwd)]` --
 * which evaluates left to right and so drained the array before
 * migrateExtensionSystem's call could push into it.)
 *
 * Requires cwd, so call this once cwd is known -- immediately before
 * runMigrations(cwd) -- rather than at the very top of main() the way the
 * env-only version of this function once was; nothing before that point
 * depends on the warning having already landed. Its return value is
 * intentionally unused: it exists only for the LEGACY_NAME_WARNINGS side
 * effect, which is also why it looks deletable and must not be deleted.
 */
export function resolveLegacyNameWarningsEarly(cwd: string): void {
	getAgentDir();
	getSessionDirEnvOverride();
	getProjectConfigDir(cwd);
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
