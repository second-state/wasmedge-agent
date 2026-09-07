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
