import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	UPDATE_COMPLETE_CUSTOM_TYPE,
	UPDATE_RESTART_CUSTOM_TYPE,
	WORKER_RECOVERY_CUSTOM_TYPE,
} from "../src/core/messages.js";
import { SessionManager } from "../src/core/session-manager.js";

/** These three customType values are written into session JSONL and are what a
 *  reload, an export, or an external consumer classifies the record by. They
 *  are wire values under rule R1 and keep their pre-rename spelling, exactly
 *  like REFINEMENT_CUSTOM_TYPE.
 *
 *  Pinned by value rather than by "producer and consumer agree", which any
 *  value would satisfy: the population this protects is the sessions already
 *  on disk and the readers outside this repository, neither of which is
 *  updated by the same commit that renames a constant. */
describe("persisted session event types", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the pre-rename wire spelling", () => {
		expect(WORKER_RECOVERY_CUSTOM_TYPE).toBe("prime-agent.worker_recovery");
		expect(UPDATE_RESTART_CUSTOM_TYPE).toBe("prime-agent.update_restart");
		expect(UPDATE_COMPLETE_CUSTOM_TYPE).toBe("prime-agent.update_complete");
	});

	it("reloads records carrying those values from disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "wasmedge-agent-wire-types-"));
		tempDirs.push(dir);
		const sessionDir = join(dir, "sessions");

		const writer = SessionManager.create(dir, sessionDir);
		writer.appendCustomMessageEntry(WORKER_RECOVERY_CUSTOM_TYPE, "worker recovered", false);
		writer.appendCustomMessageEntry(UPDATE_RESTART_CUSTOM_TYPE, "restarting for an update", false);
		writer.appendCustomMessageEntry(UPDATE_COMPLETE_CUSTOM_TYPE, "update finished", true);
		writer.flushNow();
		const sessionFile = writer.getSessionFile();
		if (!sessionFile) throw new Error("Session was not persisted");

		// On disk verbatim: a consumer outside this process matches the bytes,
		// not our constant.
		const raw = readFileSync(sessionFile, "utf-8");
		expect(raw).toContain('"prime-agent.worker_recovery"');
		expect(raw).toContain('"prime-agent.update_restart"');
		expect(raw).toContain('"prime-agent.update_complete"');

		// ...and a later process reading that same file back -- the upgrade case,
		// where the session predates the build now opening it -- classifies all
		// three with one value each.
		const reloaded = SessionManager.open(sessionFile)
			.getEntries()
			.filter((entry) => entry.type === "custom_message")
			.map((entry) => entry.customType);
		expect(reloaded).toEqual([
			"prime-agent.worker_recovery",
			"prime-agent.update_restart",
			"prime-agent.update_complete",
		]);
	});
});
