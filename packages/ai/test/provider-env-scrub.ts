/** The credential scrub applied by setup-provider-env.ts, as pure functions.
 *
 * Split out from the setup file so the matching rules are assertable against a
 * synthetic environment: the setup file runs before any test module loads, so
 * by the time a case could observe it the deletion has already happened, and
 * on a machine that never exported the variable the assertion is vacuous. */

/** Matches the shapes env-api-keys.ts consults: every `*_API_KEY` and `*_TOKEN`
 * provider variable, plus the ambient AWS and Google credential sources it
 * accepts for amazon-bedrock and google-vertex. Deliberately a pattern rather
 * than a copy of that file's provider table, which would silently stop covering
 * the suite the next time a provider is added. */
const CREDENTIAL_ENV_PATTERN = /_API_KEY$|_TOKEN$|^AWS_|^GOOGLE_|^GCLOUD_/;

/** Consulted by env-api-keys.ts but matched by no pattern above. Scrubbing the
 * variable does not fully isolate the suite: getPrimeTeamId() falls back to
 * `team_id` in ~/.prime/config.json, which no environment change can reach, so
 * a prime-inference request built in a test still carries a real team id on a
 * machine logged in with the Prime CLI. */
const CREDENTIAL_ENV_NAMES = new Set(["PRIME_TEAM_ID"]);

/** Environment variable that keeps the credentials in place. */
export const INHERIT_ENV_NAME = "PI_TEST_INHERIT_ENV";

/** Names in `env` the scrub would remove, in the order the environment lists
 * them. Pure: callers that only want to report take this, not scrubProviderEnv. */
export function providerEnvNames(env: Record<string, string | undefined>): string[] {
	return Object.keys(env).filter((name) => CREDENTIAL_ENV_PATTERN.test(name) || CREDENTIAL_ENV_NAMES.has(name));
}

/** Delete every credential variable from `env` and return what was removed. */
export function scrubProviderEnv(env: Record<string, string | undefined>): string[] {
	const removed = providerEnvNames(env);
	for (const name of removed) delete env[name];
	return removed;
}

/** One line naming what the scrub took and how to keep it, or undefined when it
 * took nothing. Printed once per run from globalSetup — a scrubbed key turns
 * every `describe.skipIf(!process.env.X)` suite into a skip, and without this
 * the run is green, the live coverage is gone, and nothing on screen connects
 * the two. */
export function scrubNotice(removed: string[]): string | undefined {
	if (removed.length === 0) return undefined;
	return (
		`Scrubbed ${removed.length} provider credential variable(s) so the suite does not ` +
		`inherit them: ${removed.join(", ")}. Credential-gated live suites will skip; ` +
		`set ${INHERIT_ENV_NAME}=1 to run them against real providers.`
	);
}
