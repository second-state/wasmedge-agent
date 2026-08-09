/** Announce, once per run, what setup-provider-env.ts is about to take away.
 *
 * The scrub has to happen per test module (setupFiles), but a message there
 * would print once per file — a thousand lines. globalSetup runs once in the
 * main process, before any worker is forked, and sees the same environment the
 * workers will inherit, so it can report the scrub without performing it. */

import { INHERIT_ENV_NAME, providerEnvNames, scrubNotice } from "./provider-env-scrub.js";

export default function setup(): void {
	if (process.env[INHERIT_ENV_NAME] === "1") return;
	const notice = scrubNotice(providerEnvNames(process.env));
	if (notice) console.warn(notice);
}
