/** Unit coverage for the credential scrub the vitest setup file applies.
 *
 * The scrub itself runs as a setupFile against the real process.env before any
 * test module loads, which makes it unobservable from inside a test: by the
 * time a case runs, the deletion has already happened and asserting on
 * process.env proves nothing on a machine that never had the variable. These
 * cases drive the same logic over a synthetic environment instead. */

import { describe, expect, it } from "vitest";
import { providerEnvNames, scrubNotice, scrubProviderEnv } from "./provider-env-scrub.js";

describe("providerEnvNames", () => {
	it("matches the credential shapes env-api-keys.ts consults", () => {
		const env = {
			ANTHROPIC_API_KEY: "x",
			OPENROUTER_API_KEY: "x",
			AWS_BEARER_TOKEN_BEDROCK: "x",
			GOOGLE_APPLICATION_CREDENTIALS: "x",
			GCLOUD_PROJECT: "x",
			PRIME_TEAM_ID: "x",
		};
		expect(providerEnvNames(env).sort()).toEqual(Object.keys(env).sort());
	});

	it("leaves variables that carry no credential alone", () => {
		const env = { PATH: "/usr/bin", HOME: "/home/me", CI: "1", PI_TEST_INHERIT_ENV: "1" };
		expect(providerEnvNames(env)).toEqual([]);
	});

	// These three are read by amazon-bedrock.ts to pick the auth mode, the HTTP
	// version and whether cache points are sent, and providers.md tells Bedrock
	// users to export exactly them. Left in place, an exported
	// AWS_BEDROCK_FORCE_CACHE=1 short-circuits supportsCachePoints() to true, so
	// a broken model-name heuristic still passes locally and only reddens CI.
	// A test that needs one of these sets it itself.
	it("scrubs the Bedrock behavior flags rather than trusting the shell", () => {
		const env = {
			AWS_BEDROCK_SKIP_AUTH: "1",
			AWS_BEDROCK_FORCE_HTTP1: "1",
			AWS_BEDROCK_FORCE_CACHE: "1",
		};
		expect(providerEnvNames(env).sort()).toEqual(Object.keys(env).sort());
	});
});

describe("scrubProviderEnv", () => {
	it("deletes the matched names and reports them", () => {
		const env = { ANTHROPIC_API_KEY: "x", PATH: "/usr/bin" };
		expect(scrubProviderEnv(env)).toEqual(["ANTHROPIC_API_KEY"]);
		expect(env).toEqual({ PATH: "/usr/bin" });
	});
});

describe("scrubNotice", () => {
	// Without this line a developer who exported a key sees a green run whose
	// live suites all skipped, and nothing on screen names the cause or the
	// way back.
	it("names the count and the opt-out so a silent skip is explainable", () => {
		const notice = scrubNotice(["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]);
		expect(notice).toContain("2");
		expect(notice).toContain("ANTHROPIC_API_KEY");
		expect(notice).toContain("PI_TEST_INHERIT_ENV=1");
	});

	it("stays quiet when the environment carried no credentials", () => {
		expect(scrubNotice([])).toBeUndefined();
	});
});
