import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** A source-order guard, and honest about being one: it proves the call sits
 *  above the others in main(), not that it executed. The property it protects
 *  is invisible at runtime until a user's config is already stranded, so a
 *  cheap structural assertion beats no assertion. */
describe("main() startup order", () => {
	const source = readFileSync(join(__dirname, "..", "src", "main.ts"), "utf-8");

	it("migrates the agent dir before anything can resolve it", () => {
		// Anchored on the call statements, not the bare names: the comment that
		// explains the hoist names isDaemonCatalogProcess() itself, and an
		// anchor that matched prose would place the early return above the very
		// line it documents and fail on a correctly ordered main().
		const migrate = source.indexOf("migrateAgentDirIfNeeded(");
		const logSink = source.indexOf("installFileLogSink(");
		const catalogReturn = source.indexOf("if (isDaemonCatalogProcess(");

		expect(migrate).toBeGreaterThan(-1);
		expect(logSink).toBeGreaterThan(-1);
		expect(catalogReturn).toBeGreaterThan(-1);
		// The log sink resolves the agent dir lazily on first write, and the
		// catalog process returns before runMigrations ever runs.
		expect(migrate).toBeLessThan(logSink);
		expect(migrate).toBeLessThan(catalogReturn);
	});

	it("clears the previous run's warnings before this run collects any", () => {
		// main() is exported, and an embedder can call it twice. The clear has
		// to sit above migrateAgentDirIfNeeded(), or a warning this run's
		// migration re-queues -- byte-identical to one the previous run
		// delivered -- would be dropped again as that run's.
		const mainStart = source.indexOf("export async function main(");
		const reset = source.indexOf("resetReportedLegacyWarnings(", mainStart);
		const migrate = source.indexOf("migrateAgentDirIfNeeded(", mainStart);

		expect(mainStart).toBeGreaterThan(-1);
		expect(reset).toBeGreaterThan(-1);
		expect(migrate).toBeGreaterThan(-1);
		expect(reset).toBeLessThan(migrate);
	});

	it("never empties the whole warning collection", () => {
		// The blanket clear reads as the obvious way to scope warnings to one
		// run, and it shipped: it erased the legacy-daemon warning that
		// cli-main.ts's migration had already queued, on the real CLI path,
		// where the move has removed the socket that warning is keyed on and
		// main()'s own migration re-derives nothing. Scoping belongs in
		// resetReportedLegacyWarnings(), which drops only what was delivered.
		const mainStart = source.indexOf("export async function main(");

		expect(mainStart).toBeGreaterThan(-1);
		expect(source.indexOf("resetLegacyNameWarnings(", mainStart)).toBe(-1);
	});

	it("sweeps the legacy environment names before the first drain", () => {
		// Anchored inside main(): reportStartupWarnings appears above it too,
		// in the exit helper that drains on a startup failure.
		const mainStart = source.indexOf("export async function main(");
		const sweep = source.indexOf("collectLegacyEnvDeprecations(", mainStart);
		const drain = source.indexOf("reportStartupWarnings(", mainStart);

		expect(sweep).toBeGreaterThan(-1);
		expect(drain).toBeGreaterThan(-1);
		expect(sweep).toBeLessThan(drain);
	});

	it("reports what startup collected before the model-listing exit", () => {
		// Structural, and honest about it: reproducing this needs a terminal,
		// because the bug is that appMode "interactive" skips the terse
		// reporter and this exit returns before the TUI the warnings were being
		// held for. What it pins is the thing that was wrong -- the exit went
		// through process.exit directly, so `model list` in a terminal was the
		// one command that could say nothing about a legacy daemon, a legacy
		// fallback, or two agent directories.
		const listModels = source.indexOf("await listModels(modelRegistry, searchPattern);");
		expect(listModels).toBeGreaterThan(-1);

		const block = source.slice(listModels, listModels + 800);
		expect(block).toContain("exitAfterMigrations(deprecationWarnings, 0)");
		// ...and nothing ends the run before it does.
		expect(block.slice(0, block.indexOf("exitAfterMigrations"))).not.toContain("process.exit(");
	});

	it("reports what startup collected when the missing-directory prompt is cancelled", () => {
		// Structural for the same reason the model-listing guard is: the exit
		// only happens in interactive mode, after a prompt. It is the one
		// interactive path that ends at status 0 on purpose, and the comment
		// above it already said it owed the user the warnings -- while the call
		// beneath the comment was a bare process.exit.
		const cancelled = source.indexOf("if (!selectedCwd) {");
		expect(cancelled).toBeGreaterThan(-1);

		const block = source.slice(cancelled, cancelled + 600);
		expect(block).toContain("exitAfterMigrations(deprecationWarnings, 0)");
		expect(block.slice(0, block.indexOf("exitAfterMigrations"))).not.toContain("process.exit(");
	});

	it("resolves legacy-aware env and project-dir getters before runMigrations snapshots their warnings", () => {
		// getSessionDirEnvOverride() has no early caller of its own the way
		// getAgentDir() gets one for free from migrateAgentDirIfNeeded(), and
		// getProjectConfigDir(cwd) has none either. Migration steps inside
		// runMigrations happen to call both today (via getSessionsDir() and
		// migrateExtensionSystem() respectively, for unrelated reasons), but
		// that is exactly the kind of accident this ordering guard exists to
		// not depend on -- see resolveLegacyNameWarningsEarly()'s doc comment
		// in config.ts.
		const resolveEarly = source.indexOf("resolveLegacyNameWarningsEarly(");
		const runMigrationsCall = source.indexOf("runMigrations(cwd)");

		expect(resolveEarly).toBeGreaterThan(-1);
		expect(runMigrationsCall).toBeGreaterThan(-1);
		expect(resolveEarly).toBeLessThan(runMigrationsCall);
	});

	it("hands the legacy-alias notice the writer that survives an exit", () => {
		// The notice takes whatever writer main() passes, and the commands that
		// print it hardest -- --version, --help, --export -- exit immediately
		// after printing. A stream closure here would put it back in a buffer
		// process.exit() abandons on macOS and Windows.
		expect(source).toContain('warnIfLegacyAlias(process.argv[1] ?? "", writeStderrSync)');
	});
});

/** runCli() is the real process entry: the shipped bin calls it, and it starts
 *  a cold daemon before ./main.js is even imported. Guarding main() alone would
 *  leave that whole path unprotected. */
describe("runCli() startup order", () => {
	const source = readFileSync(join(__dirname, "..", "src", "cli-main.ts"), "utf-8");

	it("migrates the agent dir before the early daemon launch can resolve it", () => {
		const migrate = source.indexOf("migrateAgentDirIfNeeded();");
		const earlyDaemon = source.indexOf("maybeStartDaemonEarly(process.argv");

		expect(migrate).toBeGreaterThan(-1);
		expect(earlyDaemon).toBeGreaterThan(-1);
		// maybeStartDaemonEarly's failure path writes through
		// getClientErrorLogPath(), whose appendRotatingLog mkdirSync's the new
		// logs directory into existence. Once that happens the never-clobber
		// rule correctly refuses the move, permanently.
		expect(migrate).toBeLessThan(earlyDaemon);
	});
});
