import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cpSync, renameSync } from "fs";
import { homedir } from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	LEGACY_NAME_WARNINGS,
	readLegacyEnv,
	resolveLegacyNameWarningsEarly,
} from "../src/config.js";
import {
	legacyDaemonEndpointPresent,
	migrateAgentDirIfNeeded,
	migrateAgentDirToWasmEdge,
	migrateLegacySessionDirsToSessionRoot,
	migrateSessionsFromAgentRoot,
	reportDeprecationWarningsNonInteractively,
	runMigrations,
} from "../src/migrations.js";
import { legacyDaemonEndpoint } from "../src/modes/daemon/daemon-socket-dir.js";

// Mocks the "fs" module -- the specifier migrations.ts itself imports from --
// so that renameSync and cpSync alone can be made to throw synthetic,
// code-tagged errors. Every other fs function, and these two functions' own
// default behaviour, stays real: the factory spreads `actual` and only wraps
// those two in spies whose default implementations delegate to the real ones.
// Tests that need a synthetic failure install a one-shot override with
// `mockImplementationOnce`, which self-reverts to the real implementation
// after that single call -- so no test can leak a fake error into another.
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync), cpSync: vi.fn(actual.cpSync) };
});

// The "os" mock repeats the "fs" mock's shape, for the same no-leak reason:
// migrateAgentDirIfNeeded builds the legacy path from homedir(), so pointing
// homedir() at a temp directory is the only way to
// exercise the wire-up without reaching into the developer's real home.
// Redirecting $HOME instead would bury the load-bearing detail (that POSIX
// os.homedir() consults it) in a test; overriding the function states it
// outright. mockReset() restores the implementation handed to vi.fn(), so
// nothing leaks between tests.
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>();
	return { ...actual, homedir: vi.fn(actual.homedir) };
});

describe("session migrations", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("moves legacy per-cwd session files into the flat session root", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "wasmedge-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const legacyDir = join(sessionsDir, "--tmp-project--");
		mkdirSync(legacyDir, { recursive: true });
		const legacyFile = join(legacyDir, "session-1.jsonl");
		const sessionLines = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			},
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
		];
		writeFileSync(legacyFile, `${sessionLines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		migrateLegacySessionDirsToSessionRoot();

		const migratedFile = join(sessionsDir, "session-1.jsonl");
		expect(existsSync(legacyFile)).toBe(false);
		expect(existsSync(legacyDir)).toBe(false);
		expect(readFileSync(migratedFile, "utf8")).toContain('"id":"session-1"');
	});

	it("moves root session files using only the JSONL header", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "wasmedge-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const legacyFile = join(agentDir, "session-root.jsonl");
		writeFileSync(
			legacyFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-root",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			})}\n${"x".repeat(128 * 1024)}\n`,
		);

		migrateSessionsFromAgentRoot();

		const migratedFile = join(agentDir, "sessions", "session-root.jsonl");
		expect(existsSync(legacyFile)).toBe(false);
		expect(readFileSync(migratedFile, "utf8")).toContain('"id":"session-root"');
	});

	it("does not move session files from non-legacy subdirectories", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "wasmedge-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const nonLegacyDir = join(sessionsDir, "exports");
		mkdirSync(nonLegacyDir, { recursive: true });
		const nestedFile = join(nonLegacyDir, "session-2.jsonl");
		writeFileSync(
			nestedFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-2",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			})}\n`,
		);

		migrateLegacySessionDirsToSessionRoot();

		expect(existsSync(nestedFile)).toBe(true);
		expect(existsSync(join(sessionsDir, "session-2.jsonl"))).toBe(false);
	});
});

describe("agent dir move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function root(): string {
		const dir = mkdtempSync(join(tmpdir(), "wasmedge-move-"));
		tempDirs.push(dir);
		return dir;
	}

	it("does nothing when there is no legacy directory", () => {
		const base = root();
		const result = migrateAgentDirToWasmEdge(join(base, "legacy"), join(base, "target"));
		expect(result.moved).toBe(false);
		expect(existsSync(join(base, "target"))).toBe(false);
	});

	it("moves the tree when only the legacy directory exists", () => {
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(join(legacy, "sessions"), { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"a":1}');

		const result = migrateAgentDirToWasmEdge(legacy, target);

		expect(result.moved).toBe(true);
		expect(result.from).toBe(legacy);
		expect(readFileSync(join(target, "settings.json"), "utf-8")).toBe('{"a":1}');
		expect(existsSync(join(target, "sessions"))).toBe(true);
		expect(existsSync(legacy)).toBe(false);
	});

	it("never clobbers or merges when both directories exist", () => {
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(legacy, { recursive: true });
		mkdirSync(target, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"old":true}');
		writeFileSync(join(target, "settings.json"), '{"new":true}');

		const result = migrateAgentDirToWasmEdge(legacy, target);

		expect(result.moved).toBe(false);
		expect(readFileSync(join(target, "settings.json"), "utf-8")).toBe('{"new":true}');
		expect(readFileSync(join(legacy, "settings.json"), "utf-8")).toBe('{"old":true}');
	});

	it("is a no-op on a second run", () => {
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"a":1}');

		expect(migrateAgentDirToWasmEdge(legacy, target).moved).toBe(true);
		expect(migrateAgentDirToWasmEdge(legacy, target).moved).toBe(false);
		expect(readFileSync(join(target, "settings.json"), "utf-8")).toBe('{"a":1}');
	});

	it("reports both-present separately from nothing-to-do", () => {
		// {moved:false} alone cannot tell the caller whether there was nothing
		// to migrate or whether a whole legacy configuration is sitting
		// unreadable next to an empty new one. Only the second needs a warning.
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(legacy, { recursive: true });
		mkdirSync(target, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"a":1}');

		expect(migrateAgentDirToWasmEdge(legacy, target)).toEqual({ moved: false, bothPresent: true });
		// Never merges and never clobbers: the legacy tree is left as found.
		expect(readFileSync(join(legacy, "settings.json"), "utf-8")).toBe('{"a":1}');

		// A missing legacy directory is the other case, and is not flagged.
		rmSync(legacy, { recursive: true, force: true });
		expect(migrateAgentDirToWasmEdge(legacy, target)).toEqual({ moved: false });
	});

	it("returns moved:false when the legacy directory vanishes before the call", () => {
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(legacy, { recursive: true });
		// Simulates the directory disappearing before migrateAgentDirToWasmEdge
		// is even invoked. This exercises the function's leading
		// `!existsSync(legacyDir)` guard, not the renameSync catch block below --
		// see the "renameSync error handling" tests for that.
		rmSync(legacy, { recursive: true, force: true });
		expect(migrateAgentDirToWasmEdge(legacy, target)).toEqual({ moved: false });
	});
});

describe("agent dir move / renameSync error handling", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function root(): string {
		const dir = mkdtempSync(join(tmpdir(), "wasmedge-move-errors-"));
		tempDirs.push(dir);
		return dir;
	}

	it("falls back to a real copy when renameSync reports EXDEV", () => {
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(join(legacy, "sessions"), { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"a":1}');
		writeFileSync(join(legacy, "sessions", "s1.jsonl"), "hello\n");

		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
		});

		const result = migrateAgentDirToWasmEdge(legacy, target);

		expect(result).toEqual({ moved: true, from: legacy });
		expect(readFileSync(join(target, "settings.json"), "utf-8")).toBe('{"a":1}');
		expect(readFileSync(join(target, "sessions", "s1.jsonl"), "utf-8")).toBe("hello\n");
		expect(existsSync(legacy)).toBe(false);
	});

	it("keeps a relative symlink relative across a cross-device copy", () => {
		// Node's cpSync resolves a relative symlink target against the source
		// tree and writes it back absolute unless told otherwise. This copy is
		// half of a move, and the source is deleted right after it, so a link
		// rewritten that way points at a directory that no longer exists.
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(join(legacy, "shared"), { recursive: true });
		mkdirSync(join(legacy, "prompts"), { recursive: true });
		writeFileSync(join(legacy, "shared", "note.md"), "payload");
		symlinkSync(join("..", "shared", "note.md"), join(legacy, "prompts", "note.md"));

		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
		});

		expect(migrateAgentDirToWasmEdge(legacy, target)).toEqual({ moved: true, from: legacy });

		// The legacy tree is gone, which is exactly when an absolutised target
		// stops resolving.
		expect(existsSync(legacy)).toBe(false);
		expect(readlinkSync(join(target, "prompts", "note.md"))).toBe(join("..", "shared", "note.md"));
		expect(readFileSync(join(target, "prompts", "note.md"), "utf-8")).toBe("payload");
	});

	it("leaves no partial target behind when the cross-device copy fails", () => {
		// A copy that dies part way through -- ENOSPC, one file that cannot be
		// read -- used to leave a half-populated targetDir. Every later launch
		// then took the existsSync(targetDir) early return, so the retry the
		// caller's warning promises could never happen and the preserved legacy
		// tree was never read again.
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"a":1}');

		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
		});
		vi.mocked(cpSync).mockImplementationOnce((_src, dest) => {
			mkdirSync(dest as string, { recursive: true });
			writeFileSync(join(dest as string, "settings.json"), "{");
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		});

		expect(() => migrateAgentDirToWasmEdge(legacy, target)).toThrow("no space left on device");

		// Nothing half-written survives anywhere the next launch would look --
		// neither as the target nor as an abandoned staging directory.
		expect(existsSync(target)).toBe(false);
		expect(readdirSync(base)).toEqual(["legacy"]);
		expect(readFileSync(join(legacy, "settings.json"), "utf-8")).toBe('{"a":1}');

		// ...so the retry that the caller's warning promises actually works.
		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
		});
		expect(migrateAgentDirToWasmEdge(legacy, target)).toEqual({ moved: true, from: legacy });
		expect(readFileSync(join(target, "settings.json"), "utf-8")).toBe('{"a":1}');
		expect(existsSync(legacy)).toBe(false);
	});

	it("reports moved:false for a genuine lost race", () => {
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"a":1}');

		// What a concurrent daemon worker winning the race really leaves: the
		// source gone, the data at the target, and our own renameSync failing
		// with ENOENT because there is nothing left at the source to move.
		vi.mocked(renameSync).mockImplementationOnce(() => {
			cpSync(legacy, target, { recursive: true });
			rmSync(legacy, { recursive: true, force: true });
			throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
		});

		expect(migrateAgentDirToWasmEdge(legacy, target)).toEqual({ moved: false });
		// The other process finished the move, so the data is where the next
		// getAgentDir() will look for it. Nothing is lost and nothing to warn.
		expect(readFileSync(join(target, "settings.json"), "utf-8")).toBe('{"a":1}');
	});

	it("propagates ENOENT when the legacy tree is still there", () => {
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"a":1}');

		// ENOENT with the source still present is not a lost race: no other
		// process moved anything, so a component of one of the two paths was
		// unreachable. Swallowing it would start the agent on an empty new
		// directory while every setting, credential and session sits in the
		// legacy one, and say nothing.
		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
		});

		expect(() => migrateAgentDirToWasmEdge(legacy, target)).toThrow("no such file or directory");
		expect(existsSync(target)).toBe(false);
		expect(readFileSync(join(legacy, "settings.json"), "utf-8")).toBe('{"a":1}');
	});

	it("propagates an unexpected renameSync error instead of swallowing it", () => {
		const base = root();
		const legacy = join(base, "legacy");
		const target = join(base, "target");
		mkdirSync(legacy, { recursive: true });

		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});

		expect(() => migrateAgentDirToWasmEdge(legacy, target)).toThrow();
	});
});

describe("agent dir move wire-up", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousTmpDir = process.env.TMPDIR;

	afterEach(() => {
		// Before the temp directories go, so a socket left listening cannot
		// keep one of them alive.
		if (previousTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpDir;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		vi.mocked(homedir).mockReset();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		LEGACY_NAME_WARNINGS.length = 0;
	});

	/** Points the daemon socket directory at a temp directory of our own.
	 *
	 *  os.tmpdir() reads TMPDIR on every call, and legacyDaemonEndpoint()
	 *  derives its directory from it exactly as the running build derives its
	 *  own -- so the path under test is the real one, computed by the real
	 *  function, rather than a second spelling of it that could drift. */
	function redirectSocketDir(base: string): string {
		const socketTmpDir = join(base, "socket-tmp");
		mkdirSync(socketTmpDir, { recursive: true });
		process.env.TMPDIR = socketTmpDir;
		const socketPath = legacyDaemonEndpoint();
		mkdirSync(dirname(socketPath), { recursive: true });
		return socketPath;
	}

	/** The upgrade case: a daemon from before the rename is still listening
	 *  while the configuration directory moves out from under it.
	 *
	 *  Unix sockets only, which is also all the detection claims: on Windows
	 *  the previous release used a named pipe, nothing exists at the derived
	 *  path, and the check correctly finds nothing. */
	it.skipIf(process.platform === "win32")(
		"still migrates when a daemon from the previous release is listening, and says so",
		async () => {
			const base = mkdtempSync(join(tmpdir(), "wasmedge-move-daemon-"));
			tempDirs.push(base);
			const legacy = join(base, ".prime", "agent");
			const target = join(base, ".wasmedge-agent");
			mkdirSync(join(legacy, "sessions"), { recursive: true });
			writeFileSync(join(legacy, "auth.json"), '{"anthropic":1}');
			writeFileSync(join(legacy, "sessions", "s.jsonl"), '{"type":"session"}\n');
			vi.mocked(homedir).mockReturnValue(base);
			process.env[ENV_AGENT_DIR] = target;
			const socketPath = redirectSocketDir(base);

			const server = createServer();
			await new Promise<void>((listening) => server.listen(socketPath, listening));
			try {
				// Refusing to move here would be worse than the divergence it
				// avoids: the never-clobber rule then strands the legacy tree
				// permanently, because the new directory appears in this same run.
				expect(migrateAgentDirIfNeeded()).toEqual({ moved: true, from: legacy });
			} finally {
				await new Promise<void>((closed) => server.close(() => closed()));
			}

			// Everything that was in the legacy tree is in the new one.
			expect(readFileSync(join(target, "auth.json"), "utf-8")).toBe('{"anthropic":1}');
			expect(readFileSync(join(target, "sessions", "s.jsonl"), "utf-8")).toBe('{"type":"session"}\n');
			expect(existsSync(legacy)).toBe(false);

			// ...and the user is told which daemon to stop, by its socket path,
			// through the channel every mode already drains.
			const warnings = LEGACY_NAME_WARNINGS.filter((w) => w.includes(socketPath));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("Stop it");
		},
	);

	it("keeps the legacy endpoint each platform actually used", () => {
		// Pinned by value on both sides. The endpoint is not ours to rename --
		// it is what the previously released build created -- so comparing the
		// function with itself would hold for a spelling that finds nothing.
		expect(legacyDaemonEndpoint("win32")).toBe("\\\\.\\pipe\\prime-agent-daemon");

		const posix = legacyDaemonEndpoint("linux");
		expect(posix.startsWith(tmpdir())).toBe(true);
		expect(posix.endsWith("daemon.sock")).toBe(true);
	});

	it("finds a legacy named pipe by a case-insensitive listing, and never throws", () => {
		// Windows has no file to stat, and the POSIX branch would find nothing
		// there forever. A pipe is listed only while a server holds it open, so
		// this branch is closer to liveness than the POSIX one, not weaker.
		const base = mkdtempSync(join(tmpdir(), "wasmedge-pipe-dir-"));
		tempDirs.push(base);
		const pipeDir = join(base, "pipes");
		mkdirSync(pipeDir, { recursive: true });
		const endpoint = legacyDaemonEndpoint("win32");
		const pipeName = endpoint.slice(endpoint.lastIndexOf("\\") + 1);

		expect(legacyDaemonEndpointPresent(endpoint, "win32", pipeDir)).toBe(false);

		// Windows pipe names are case-insensitive, so a listing that differs
		// only in case is the same pipe.
		writeFileSync(join(pipeDir, pipeName.toUpperCase()), "");
		expect(legacyDaemonEndpointPresent(endpoint, "win32", pipeDir)).toBe(true);

		// The listing is not guaranteed on every configuration, and this runs
		// before the application has started: a failure to look must cost a
		// warning, not the process.
		expect(legacyDaemonEndpointPresent(endpoint, "win32", join(base, "no-such-pipe-dir"))).toBe(false);
	});

	it("says nothing about a daemon when the legacy socket path holds no socket", () => {
		const base = mkdtempSync(join(tmpdir(), "wasmedge-move-no-daemon-"));
		tempDirs.push(base);
		const legacy = join(base, ".prime", "agent");
		const target = join(base, ".wasmedge-agent");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "auth.json"), "{}");
		vi.mocked(homedir).mockReturnValue(base);
		process.env[ENV_AGENT_DIR] = target;
		// A regular file, which is the stronger negative: existence alone must
		// not warn, or every run with a leftover file in a shared temp
		// directory reports a daemon that never existed.
		const socketPath = redirectSocketDir(base);
		writeFileSync(socketPath, "not a socket");

		expect(migrateAgentDirIfNeeded()).toEqual({ moved: true, from: legacy });
		expect(LEGACY_NAME_WARNINGS.filter((w) => w.includes("previous release"))).toHaveLength(0);
	});

	it("warns and continues when the move fails unexpectedly, rather than blocking startup", () => {
		const base = mkdtempSync(join(tmpdir(), "wasmedge-move-wireup-"));
		tempDirs.push(base);
		const legacy = join(base, ".prime", "agent");
		const target = join(base, ".wasmedge-agent");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"a":1}');
		vi.mocked(homedir).mockReturnValue(base);
		process.env[ENV_AGENT_DIR] = target;

		const boom = () => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		};
		const written: string[] = [];
		const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			written.push(args.join(" "));
		});

		try {
			// The pure function's contract is unchanged: it still propagates.
			vi.mocked(renameSync).mockImplementationOnce(boom);
			expect(() => migrateAgentDirToWasmEdge(legacy, target)).toThrow();

			// The caller absorbs it. main() runs this as its first statement, so
			// a throw escaping here would stop the application from starting at
			// all -- on Windows a file the old daemon still holds open is enough.
			vi.mocked(renameSync).mockImplementationOnce(boom);
			// `failed`, not a bare `{ moved: false }`: a caller about to create
			// the target directory has to be able to tell an interrupted move
			// from there being nothing to move.
			expect(migrateAgentDirIfNeeded()).toEqual({ moved: false, failed: true });
		} finally {
			consoleError.mockRestore();
		}

		// The warning has to be actionable: both paths and the cause.
		const warning = written.join("\n");
		expect(warning).toContain(legacy);
		expect(warning).toContain(target);
		expect(warning).toContain("permission denied");
		// Nothing was lost, so the next launch can retry the move.
		expect(readFileSync(join(legacy, "settings.json"), "utf-8")).toBe('{"a":1}');
	});

	it("keeps the retry possible after a failed move, and loses it once the target is created", () => {
		// The postinstall sequence, in order: `npm install -g` runs the move, it
		// fails, and the bootstrap that follows would create the managed-binaries
		// directory under the target. The move is idempotent and retries on the
		// next launch -- but only while the target is absent, because the
		// never-clobber rule refuses a move into a directory that already
		// exists. That makes whatever creates it first the thing that decides
		// the legacy tree is never read again, which is why postinstall.ts stops
		// on `failed` instead of bootstrapping.
		const base = mkdtempSync(join(tmpdir(), "wasmedge-move-retry-"));
		tempDirs.push(base);
		const legacy = join(base, ".prime", "agent");
		const target = join(base, ".wasmedge-agent");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "auth.json"), '{"anthropic":1}');
		vi.mocked(homedir).mockReturnValue(base);
		process.env[ENV_AGENT_DIR] = target;

		const boom = () => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		};
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			vi.mocked(renameSync).mockImplementationOnce(boom);
			expect(migrateAgentDirIfNeeded().failed).toBe(true);
			// The failure created nothing, so a second attempt is a real retry.
			expect(existsSync(target)).toBe(false);
			expect(migrateAgentDirIfNeeded()).toEqual({ moved: true, from: legacy });
			expect(readFileSync(join(target, "auth.json"), "utf-8")).toBe('{"anthropic":1}');
		} finally {
			consoleError.mockRestore();
		}
	});

	it("refuses the move for good once bootstrap work creates the target after a failure", () => {
		// The other half of the pair above, and the reason postinstall.ts stops:
		// this is what ensureTool() did between the failed move and the next
		// launch. Nothing is destroyed, but the configuration is stranded --
		// the retry the warning promised can never happen again.
		const base = mkdtempSync(join(tmpdir(), "wasmedge-move-stranded-"));
		tempDirs.push(base);
		const legacy = join(base, ".prime", "agent");
		const target = join(base, ".wasmedge-agent");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "auth.json"), '{"anthropic":1}');
		vi.mocked(homedir).mockReturnValue(base);
		process.env[ENV_AGENT_DIR] = target;

		const boom = () => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		};
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			vi.mocked(renameSync).mockImplementationOnce(boom);
			expect(migrateAgentDirIfNeeded().failed).toBe(true);

			// tools-manager.ts's mkdir -p, standing in for the bootstrap.
			mkdirSync(join(target, "bin"), { recursive: true });

			expect(migrateAgentDirIfNeeded()).toEqual({ moved: false, bothPresent: true });
		} finally {
			consoleError.mockRestore();
		}

		// Intact, and unread: the agent starts from the empty new directory.
		expect(readFileSync(join(legacy, "auth.json"), "utf-8")).toBe('{"anthropic":1}');
		expect(existsSync(join(target, "auth.json"))).toBe(false);
		expect(LEGACY_NAME_WARNINGS.filter((w) => w.includes("both exist, so nothing was migrated"))).toHaveLength(1);
	});

	it("warns through the deprecation channel when both directories exist", () => {
		// The state the installer manufactures: npm install -g runs postinstall,
		// which creates ~/.wasmedge-agent/bin, while the user's real
		// configuration is still in the legacy tree. Before this warning the CLI
		// started with no auth, no sessions and no settings, and said nothing on
		// either stream.
		const base = mkdtempSync(join(tmpdir(), "wasmedge-move-both-"));
		const cwd = mkdtempSync(join(tmpdir(), "wasmedge-move-both-cwd-"));
		tempDirs.push(base, cwd);
		const legacy = join(base, ".prime", "agent");
		const target = join(base, ".wasmedge-agent");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "auth.json"), "{}");
		mkdirSync(join(target, "bin"), { recursive: true });
		vi.mocked(homedir).mockReturnValue(base);
		process.env[ENV_AGENT_DIR] = target;

		expect(migrateAgentDirIfNeeded()).toEqual({ moved: false, bothPresent: true });

		// It must reach the channel main() already renders, not a bare console
		// write of its own -- runMigrations' snapshot is what every mode drains.
		const { deprecationWarnings } = runMigrations(cwd);
		const both = deprecationWarnings.filter((w) => w.includes(legacy) && w.includes(target));
		expect(both).toHaveLength(1);
		// Naming both directories is not enough: it has to say which one is live.
		expect(both[0]).toContain(`${target} is the one in use`);

		// Nothing was moved or removed, and a second call does not double up.
		expect(readFileSync(join(legacy, "auth.json"), "utf-8")).toBe("{}");
		migrateAgentDirIfNeeded();
		expect(LEGACY_NAME_WARNINGS.filter((w) => w.includes(legacy))).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")(
		"reports both directories once a legacy writer recreates the tree after the move",
		async () => {
			// The mitigation the design leans on. The old daemon is not stopped
			// and not reachable, so it goes on writing under the legacy path;
			// what has to hold is that the next launch finds both directories
			// and says which one is live, rather than starting on the new one
			// in silence.
			const base = mkdtempSync(join(tmpdir(), "wasmedge-move-relapse-"));
			const cwd = mkdtempSync(join(tmpdir(), "wasmedge-move-relapse-cwd-"));
			tempDirs.push(base, cwd);
			const legacy = join(base, ".prime", "agent");
			const target = join(base, ".wasmedge-agent");
			mkdirSync(legacy, { recursive: true });
			writeFileSync(join(legacy, "auth.json"), '{"anthropic":1}');
			vi.mocked(homedir).mockReturnValue(base);
			process.env[ENV_AGENT_DIR] = target;
			const socketPath = redirectSocketDir(base);

			const server = createServer();
			await new Promise<void>((listening) => server.listen(socketPath, listening));
			try {
				expect(migrateAgentDirIfNeeded()).toEqual({ moved: true, from: legacy });

				// Stands in for the daemon this build cannot reach: it still
				// holds absolute paths under the legacy tree, so its next write
				// recreates the directory the move just emptied.
				mkdirSync(join(legacy, "sessions"), { recursive: true });
				writeFileSync(join(legacy, "sessions", "orphan.jsonl"), '{"type":"session"}\n');

				expect(migrateAgentDirIfNeeded()).toEqual({ moved: false, bothPresent: true });
			} finally {
				await new Promise<void>((closed) => server.close(() => closed()));
			}

			// Nothing was clobbered either way, and the user is told where each
			// half of their state is.
			expect(readFileSync(join(target, "auth.json"), "utf-8")).toBe('{"anthropic":1}');
			expect(readFileSync(join(legacy, "sessions", "orphan.jsonl"), "utf-8")).toBe('{"type":"session"}\n');
			const bothDirs = LEGACY_NAME_WARNINGS.filter((w) => w.includes("both exist, so nothing was migrated"));
			expect(bothDirs).toHaveLength(1);
			expect(bothDirs[0]).toContain(`${target} is the one in use`);
		},
	);

	it("still performs the move when nothing goes wrong, and clears the empty legacy parent", () => {
		const base = mkdtempSync(join(tmpdir(), "wasmedge-move-wireup-"));
		tempDirs.push(base);
		const legacy = join(base, ".prime", "agent");
		const target = join(base, ".wasmedge-agent");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"a":1}');
		vi.mocked(homedir).mockReturnValue(base);
		process.env[ENV_AGENT_DIR] = target;

		expect(migrateAgentDirIfNeeded()).toEqual({ moved: true, from: legacy });
		expect(readFileSync(join(target, "settings.json"), "utf-8")).toBe('{"a":1}');
		expect(existsSync(legacy)).toBe(false);
		// Nothing else was in it, so the shell it left behind goes too.
		expect(existsSync(join(base, ".prime"))).toBe(false);
	});

	it("keeps the legacy parent when Prime Inference still has a file in it", () => {
		// ~/.prime is not ours. The provider's own credentials live at
		// ~/.prime/config.json and the rebrand must not move or delete them.
		const base = mkdtempSync(join(tmpdir(), "wasmedge-move-wireup-"));
		tempDirs.push(base);
		const legacyParent = join(base, ".prime");
		const legacy = join(legacyParent, "agent");
		const target = join(base, ".wasmedge-agent");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"a":1}');
		writeFileSync(join(legacyParent, "config.json"), '{"api_key":"provider"}');
		vi.mocked(homedir).mockReturnValue(base);
		process.env[ENV_AGENT_DIR] = target;

		expect(migrateAgentDirIfNeeded()).toEqual({ moved: true, from: legacy });
		expect(readFileSync(join(legacyParent, "config.json"), "utf-8")).toBe('{"api_key":"provider"}');
	});
});

describe("reportDeprecationWarningsNonInteractively", () => {
	it("writes each warning to the given writer, one per line", () => {
		const written: string[] = [];
		reportDeprecationWarningsNonInteractively(["first thing", "second thing"], (m) => written.push(m));

		expect(written).toEqual(["Warning: first thing\n", "Warning: second thing\n"]);
	});

	it("writes nothing when there are no warnings", () => {
		const written: string[] = [];
		reportDeprecationWarningsNonInteractively([], (m) => written.push(m));

		expect(written).toHaveLength(0);
	});
});

// This is the property the interactive-only channel silently broke: a
// legacy env var resolves correctly in every mode, but only interactive mode
// ever told the user it was deprecated. Non-interactive modes (--print,
// --json, rpc, acp, daemon) got the same silent-fallback treatment the whole
// compatibility window exists to avoid.
describe("legacy env var deprecation reaches stderr in non-interactive mode", () => {
	const previousLegacy = process.env.PRIME_AGENT_CODING_AGENT_DIR;
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		if (previousLegacy === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
		else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousLegacy;
		LEGACY_NAME_WARNINGS.length = 0;
	});

	it("warns on stderr and leaves stdout untouched", () => {
		const legacyAgentDir = mkdtempSync(join(tmpdir(), "wasmedge-legacy-agent-dir-"));
		const cwd = mkdtempSync(join(tmpdir(), "wasmedge-legacy-cwd-"));
		tempDirs.push(legacyAgentDir, cwd);
		process.env.PRIME_AGENT_CODING_AGENT_DIR = legacyAgentDir;

		// Mirrors main(): migrateAgentDirIfNeeded()'s getAgentDir() call resolves
		// the legacy fallback -- and records the one-time warning -- before
		// runMigrations ever runs.
		expect(readLegacyEnv(ENV_AGENT_DIR)).toBe(legacyAgentDir);

		const { deprecationWarnings } = runMigrations(cwd);

		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderrWritten: string[] = [];
		try {
			reportDeprecationWarningsNonInteractively(deprecationWarnings, (m) => stderrWritten.push(m));
		} finally {
			stdoutWrite.mockRestore();
		}

		expect(stderrWritten).toHaveLength(1);
		expect(stderrWritten[0]).toContain("PRIME_AGENT_CODING_AGENT_DIR");
		expect(stdoutWrite).not.toHaveBeenCalled();
	});
});

// getSessionDirEnvOverride() has no early caller of its own the way
// getAgentDir() gets one for free from migrateAgentDirIfNeeded(). Note for
// whoever next touches runMigrations: today migrateLegacySessionDirsToSessionRoot()
// happens to call getSessionsDir() (and so getSessionDirEnvOverride())
// unconditionally, before the deprecationWarnings snapshot is taken, so this
// warning currently reaches the snapshot either way. That coverage is
// incidental to a migration step that exists for an unrelated reason (moving
// legacy per-cwd session directories) and is not something to depend on --
// resolveLegacyNameWarningsEarly() makes the guarantee explicit and
// independent of that migration step's internals ever staying unconditional.
describe("legacy session-dir variable reaches the deprecation snapshot", () => {
	const previousLegacy = process.env.PRIME_AGENT_SESSION_DIR;
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		if (previousLegacy === undefined) delete process.env.PRIME_AGENT_SESSION_DIR;
		else process.env.PRIME_AGENT_SESSION_DIR = previousLegacy;
		LEGACY_NAME_WARNINGS.length = 0;
	});

	it("populates LEGACY_NAME_WARNINGS by itself, without any migration step needing to run first", () => {
		const legacySessionDir = mkdtempSync(join(tmpdir(), "wasmedge-legacy-session-dir-"));
		const cwd = mkdtempSync(join(tmpdir(), "wasmedge-legacy-session-cwd-"));
		tempDirs.push(legacySessionDir, cwd);
		process.env.PRIME_AGENT_SESSION_DIR = legacySessionDir;

		resolveLegacyNameWarningsEarly(cwd);

		const sessionDirWarning = LEGACY_NAME_WARNINGS.find((w) => w.includes("PRIME_AGENT_SESSION_DIR"));
		expect(sessionDirWarning).toBeDefined();
		expect(sessionDirWarning).toContain(ENV_SESSION_DIR);
	});

	it("is surfaced in runMigrations' deprecationWarnings when resolveLegacyNameWarningsEarly runs first, mirroring main()'s own ordering", () => {
		const legacySessionDir = mkdtempSync(join(tmpdir(), "wasmedge-legacy-session-dir-"));
		const cwd = mkdtempSync(join(tmpdir(), "wasmedge-legacy-session-cwd-"));
		tempDirs.push(legacySessionDir, cwd);
		process.env.PRIME_AGENT_SESSION_DIR = legacySessionDir;

		resolveLegacyNameWarningsEarly(cwd);
		const { deprecationWarnings } = runMigrations(cwd);

		const sessionDirWarning = deprecationWarnings.find((w) => w.includes("PRIME_AGENT_SESSION_DIR"));
		expect(sessionDirWarning).toBeDefined();
		expect(sessionDirWarning).toContain(ENV_SESSION_DIR);
	});
});

// getProjectConfigDir(cwd) has no early caller of its own either. Note for
// whoever next touches runMigrations: today migrateExtensionSystem() happens
// to call it unconditionally (via its own join-the-project-dir step, for the
// unrelated commands->prompts migration), before the deprecationWarnings
// snapshot is taken, so this warning currently reaches the snapshot either
// way -- but only because that snapshot now reads LEGACY_NAME_WARNINGS after
// migrateExtensionSystem's call completes, not during it. Array-literal
// spread evaluates left to right, so a deprecationWarnings assembled as
// `[...LEGACY_NAME_WARNINGS, ...migrateExtensionSystem(cwd)]` would read
// LEGACY_NAME_WARNINGS before that call could push into it and silently drop
// this warning -- exactly what happened until this test was added.
// resolveLegacyNameWarningsEarly() makes the guarantee explicit and
// independent of that migration step's internals ever staying unconditional
// or of runMigrations' own evaluation order.
describe("legacy project-local config dir reaches the deprecation snapshot", () => {
	const tempDirs: string[] = [];

	function legacyProjectCwd(): string {
		const cwd = mkdtempSync(join(tmpdir(), "wasmedge-legacy-project-cwd-"));
		tempDirs.push(cwd);
		mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
		return cwd;
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		LEGACY_NAME_WARNINGS.length = 0;
	});

	it("populates LEGACY_NAME_WARNINGS by itself, without any migration step needing to run first", () => {
		const cwd = legacyProjectCwd();

		resolveLegacyNameWarningsEarly(cwd);

		const projectDirWarning = LEGACY_NAME_WARNINGS.find((w) => w.includes(join(".prime", "agent")));
		expect(projectDirWarning).toBeDefined();
		expect(projectDirWarning).toContain(".wasmedge-agent");
	});

	it("is surfaced in runMigrations' deprecationWarnings when resolveLegacyNameWarningsEarly runs first, mirroring main()'s own ordering", () => {
		const cwd = legacyProjectCwd();

		resolveLegacyNameWarningsEarly(cwd);
		const { deprecationWarnings } = runMigrations(cwd);

		const projectDirWarning = deprecationWarnings.find((w) => w.includes(join(".prime", "agent")));
		expect(projectDirWarning).toBeDefined();
		expect(projectDirWarning).toContain(".wasmedge-agent");
	});

	// This is the regression test for the bug itself: no early call, relying
	// solely on migrateExtensionSystem()'s own incidental call to
	// getProjectConfigDir(cwd) inside runMigrations. Before the fix to the
	// deprecationWarnings spread in runMigrations, this failed -- the push
	// happened during evaluation of the array literal's second spread
	// operand, after LEGACY_NAME_WARNINGS's first operand had already been
	// read, so the warning never reached the returned array even though it
	// was really in LEGACY_NAME_WARNINGS by the time runMigrations returned.
	it("reaches deprecationWarnings from migrateExtensionSystem's own incidental call, with no early resolution at all", () => {
		const cwd = legacyProjectCwd();

		const { deprecationWarnings } = runMigrations(cwd);

		const projectDirWarning = deprecationWarnings.find((w) => w.includes(join(".prime", "agent")));
		expect(projectDirWarning).toBeDefined();
		expect(projectDirWarning).toContain(".wasmedge-agent");
	});
});
