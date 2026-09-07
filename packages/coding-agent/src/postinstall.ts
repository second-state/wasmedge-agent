import { LEGACY_NAME_WARNINGS, readLegacyEnv } from "./config.js";
import { ensureTemplateReady, resolveToolchain } from "./core/rust-cell/index.js";
import { migrateAgentDirIfNeeded, reportDeprecationWarningsNonInteractively } from "./migrations.js";
import { ensureTool } from "./utils/tools-manager.js";

// First statement, before anything here can create the agent directory.
// `npm install -g` runs this script, and ensureTool() below mkdir -p's the
// managed-binaries directory under it; once that exists, the never-clobber
// rule in migrateAgentDirToWasmEdge correctly refuses the move forever and
// strands the user's whole legacy configuration. install.sh sets
// WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=1, so this is the installer's own
// path, not a hypothetical one. The move is idempotent, so the CLI running it
// again on its next launch costs nothing.
//
// Creating it is what matters here, not resolving it: tools-manager.ts reads
// the managed-binaries path once at module scope, so the import above already
// resolved it, and the move has to happen before anything writes there rather
// than before anything reads the path.
const agentDirMigration = migrateAgentDirIfNeeded();

/**
 * Writes the deprecation warnings queued so far to stderr, and empties the
 * queue so a second call cannot repeat one.
 *
 * This process never reaches main(), so main()'s reporter never runs for it,
 * yet everything above queues into the same list: migrateAgentDirIfNeeded()
 * can record that both agent directories exist, and readLegacyEnv() below
 * records a legacy variable name it fell back to. Without this the fallback
 * works and the notice is never printed -- and `npm install -g` is exactly
 * the situation that creates the both-directories state, so this is the
 * common case rather than a corner one.
 *
 * stderr, not stdout: npm shows both, and a package manager's stdout is not
 * a place to put diagnostics.
 */
function reportPostinstallWarnings(): void {
	reportDeprecationWarningsNonInteractively(LEGACY_NAME_WARNINGS.splice(0), (message) =>
		process.stderr.write(message),
	);
}

const bootstrapRuntime = readLegacyEnv("WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL") === "1";
const bootstrapTools = readLegacyEnv("WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL") === "1";

// Before the early exit below, which is the path most installs take.
reportPostinstallWarnings();

if (!bootstrapRuntime && !bootstrapTools) {
	process.exit(0);
}

// A failed move leaves the configuration in the legacy tree with the new
// directory still absent, and the warning migrateAgentDirIfNeeded() just wrote
// promises a retry on the next launch. The bootstrap below is what would break
// that promise: tools-manager.ts captured the managed-binaries path under the
// new directory when this module imported it, before the move ran, so
// ensureTool() creates that directory whatever the move did -- and with both
// directories present the never-clobber rule refuses the move forever, leaving
// the user's credentials, settings and sessions in a tree nothing reads again.
//
// Skipping costs one `wasmedge-agent` launch to fetch fd and rg, which the
// agent does on demand anyway. Not skipping costs the whole configuration.
if (agentDirMigration.failed) {
	console.error(
		"wasmedge-agent: postinstall setup skipped so the interrupted configuration move can be retried on the next launch.",
	);
	process.exit(0);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function oneLine(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

try {
	if (bootstrapTools) {
		await Promise.all([ensureTool("fd", true), ensureTool("rg", true)]);
	}
	if (bootstrapRuntime) {
		const toolchain = resolveToolchain();
		ensureTemplateReady(toolchain.cargoBin, (message) => console.log(`wasmedge-agent: ${message}`));
	}
} catch (error) {
	console.error(`wasmedge-agent: postinstall setup skipped: ${oneLine(errorMessage(error))}`);
}

// Again, for anything the bootstrap work queued. The queue was emptied above,
// so nothing already reported can repeat.
reportPostinstallWarnings();
