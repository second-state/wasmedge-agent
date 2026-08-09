/** Keep the suite hermetic against the developer's own provider credentials.
 *
 * Model discovery reads process.env directly (packages/ai/src/env-api-keys.ts:
 * findEnvKeys / getEnvApiKey), so an exported key makes a provider the tests
 * expect to be unconfigured show up as configured. On a machine with
 * XAI_API_KEY and AWS_BEARER_TOKEN_BEDROCK exported, the OAuth selector's sort,
 * fast-mode's model cycling and subagent model selection all assert against a
 * provider list that has grown entries the test never added. Nothing in those
 * failures points at the environment, so they read as real regressions.
 *
 * setupFiles run before each test module is imported, so this also lands ahead
 * of the modules that capture `const original = process.env.X` at top level:
 * they see undefined and restore by deleting, which is what we want. A test
 * that needs a credential still sets it itself, afterwards.
 *
 * Set PI_TEST_INHERIT_ENV=1 to opt out. The live E2E suites gate on real keys
 * being present (`describe.skipIf(!process.env.ANTHROPIC_API_KEY)` and friends),
 * so running those against a real provider needs the environment intact. What
 * that costs by default is announced once per run by globalSetup — see
 * global-setup-provider-env.ts. The matching rules live in
 * provider-env-scrub.ts, where they are unit-tested.
 *
 * This file runs per test module, so it stays a scrub and prints nothing. */

import { scrubProviderEnv } from "./provider-env-scrub.js";

/* Compared against "1" rather than tested for truthiness: every non-empty
 * string is truthy, so `PI_TEST_INHERIT_ENV=0` would read as "opt out" and hand
 * the live suites the developer's real keys — billed provider calls reached
 * through the spelling that means the opposite. Anything but "1" scrubs. */
if (process.env.PI_TEST_INHERIT_ENV !== "1") {
	scrubProviderEnv(process.env);
}
