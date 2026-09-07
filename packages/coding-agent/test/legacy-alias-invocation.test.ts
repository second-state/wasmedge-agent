import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../tsconfig.json");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
	/** The real exit status. null means the process died from a signal, which
	 *  is never a pass: converting that to 0 is how a test stops being able to
	 *  fail for the reason it exists. */
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

interface RunSession {
	/** Sends one NDJSON request on stdin. */
	send(request: unknown): void;
	/** Resolves with the first complete stdout line matching, or rejects. */
	nextStdoutLine(matches: (line: string) => boolean, timeoutMs?: number): Promise<string>;
	/** Ends stdin, which is how every protocol mode is asked to shut down. */
	close(): void;
	/** Settles when the child has exited, so a driver can order work against
	 *  the shutdown it asked for rather than against a guessed delay. */
	readonly closed: Promise<void>;
}

/**
 * Writes an entry point that reports stdin as a TTY and then loads the CLI,
 * and returns its path.
 *
 * resolveAppMode() answers "print" for anything whose stdin is not a
 * terminal, and a spawned child has none -- so without this no test here can
 * reach interactive mode, which is precisely the mode that holds its
 * migration warnings back for the TUI and the one where a failure before the
 * TUI used to discard them. Nothing else about the run is faked: the same
 * entry, the same argv, a real child process.
 *
 * Two files with static imports rather than one with a dynamic import.
 * Modules evaluate in import order, so the shim sets the flag before the CLI
 * module body runs; a static import in a single file would be hoisted above
 * the assignment and be too late.
 */
function writeInteractiveEntry(home: string): string {
	const shimPath = join(home, "tty-shim.mjs");
	writeFileSync(shimPath, 'Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });\n');
	const entryPath = join(home, "interactive-entry.mjs");
	writeFileSync(
		entryPath,
		`import ${JSON.stringify(pathToFileURL(shimPath).href)};\n` +
			`import ${JSON.stringify(pathToFileURL(cliPath).href)};\n`,
	);
	return entryPath;
}

/**
 * Runs the CLI through a command name of our choosing.
 *
 * What this reproduces, and what it does not. npm installs a bin by
 * symlinking the command name at the package's entry script, so the only
 * thing the legacy alias changes about a run is `process.argv[1]`: the same
 * entry, reached under a different basename. That is exactly what this builds
 * -- a symlink under the given name, pointing at the real CLI entry -- so the
 * detection, the stream the notice goes to, and the cleanliness of stdout are
 * all the real ones.
 *
 * It does not pack a tarball or run `npm install -g`, so it does not prove the
 * packed manifest still declares the alias in its bin map. That claim is the
 * pack script's, and check-branding's allowlist entry for it holds the bin map
 * in place.
 *
 * `options.interactive` points that symlink at writeInteractiveEntry()'s pair
 * instead, which is the only way a child process reaches interactive mode.
 */
async function runAs(
	commandName: string,
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
	/** Drives a mode that waits for input, and must close the session. */
	drive?: (session: RunSession) => Promise<void>,
	options: { interactive?: boolean } = {},
): Promise<RunResult> {
	const home = mkdtempSync(join(tmpdir(), "wasmedge-agent-alias-"));
	tempDirs.push(home);
	const binDir = join(home, "bin");
	mkdirSync(binDir, { recursive: true });
	const binPath = join(binDir, commandName);
	symlinkSync(options.interactive ? writeInteractiveEntry(home) : cliPath, binPath);
	// The default daemon socket lives under the temp directory and is shared
	// per user, not per agent directory, so two runs in one suite reach for the
	// same socket and one of them loses it mid-request. A private temp
	// directory gives this run a socket of its own, the way the daemon suites
	// already isolate theirs.
	const socketTmpDir = join(home, "socket-tmp");
	mkdirSync(socketTmpDir, { recursive: true });

	const child = spawn(process.execPath, [tsxPath, binPath, ...args], {
		cwd: home,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			WASMEDGE_AGENT_CODING_AGENT_DIR: join(home, "agent"),
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			TMPDIR: socketTmpDir,
			TSX_TSCONFIG_PATH: tsconfigPath,
			...extraEnv,
		},
		stdio: [drive ? "pipe" : "ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let pendingStdout = "";
	const stdoutLines: string[] = [];
	const stdoutWaiters: Array<{
		matches: (line: string) => boolean;
		resolve: (line: string) => void;
		reject: (error: Error) => void;
	}> = [];
	child.stdout?.on("data", (chunk) => {
		stdout += String(chunk);
		pendingStdout += String(chunk);
		let newline = pendingStdout.indexOf("\n");
		while (newline !== -1) {
			const line = pendingStdout.slice(0, newline);
			pendingStdout = pendingStdout.slice(newline + 1);
			const waiterIndex = stdoutWaiters.findIndex((waiter) => waiter.matches(line));
			if (waiterIndex === -1) stdoutLines.push(line);
			else stdoutWaiters.splice(waiterIndex, 1)[0]?.resolve(line);
			newline = pendingStdout.indexOf("\n");
		}
	});
	child.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});

	let markClosed: () => void = () => {};
	const childClosed = new Promise<void>((settle) => {
		markClosed = settle;
	});

	const session: RunSession = {
		send: (request) => child.stdin?.write(`${JSON.stringify(request)}\n`),
		nextStdoutLine: (matches, timeoutMs = 60_000) => {
			const buffered = stdoutLines.findIndex(matches);
			if (buffered !== -1) return Promise.resolve(stdoutLines.splice(buffered, 1)[0] as string);
			return new Promise((resolveLine, rejectLine) => {
				const timer = setTimeout(() => rejectLine(new Error("Timed out waiting for a stdout line")), timeoutMs);
				stdoutWaiters.push({
					matches,
					resolve: (line) => {
						clearTimeout(timer);
						resolveLine(line);
					},
					reject: (error) => {
						clearTimeout(timer);
						rejectLine(error);
					},
				});
			});
		},
		close: () => child.stdin?.end(),
		closed: childClosed,
	};

	const closed = new Promise<RunResult>((resolveClose, rejectClose) => {
		child.on("error", rejectClose);
		child.on("close", (code, signal) => {
			// Nothing more is coming, so a waiter still pending would otherwise
			// sit out its whole timeout and report the wrong failure.
			for (const waiter of stdoutWaiters.splice(0)) {
				waiter.reject(
					new Error(
						`Process closed before a matching stdout line (code ${code}, signal ${signal})\nstderr: ${stderr}`,
					),
				);
			}
			markClosed();
			resolveClose({ code, signal, stdout, stderr });
		});
	});

	if (!drive) return closed;

	const driven = drive(session).catch((error: unknown) => {
		// The driver cannot finish, so the child will not be asked to stop.
		child.kill("SIGKILL");
		throw error;
	});

	// Both, not whichever lands first. Resolving on close alone let the caller
	// read state the driver had not written yet -- which is not theoretical:
	// it made the assertion below read an undefined response on a full-suite
	// run while a focused run passed -- and dropped a driver rejection that
	// arrived after the child had already closed.
	const [result] = await Promise.all([closed, driven]);
	return result;
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("legacy command alias, end to end", () => {
	it("warns on stderr and leaves a protocol stdout byte-clean", async () => {
		const result = await runAs("prime-agent", ["doctor", "--json"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("'prime-agent' is deprecated");
		expect(result.stderr).toContain("wasmedge-agent");

		// --json's contract is one document and nothing else. A notice on
		// stdout would not merely be untidy; it would break every client that
		// parses this stream, which is why the notice has its own writer.
		expect(() => JSON.parse(result.stdout)).not.toThrow();
		expect(result.stdout).not.toContain("deprecated");
	}, 120_000);

	it("warns before an early-return command exits", async () => {
		// --version prints and calls process.exit() directly. This notice comes
		// from a different writer than the migration warnings, and a stream
		// write still buffered at that call is discarded wherever stderr is
		// asynchronous -- a pipe on macOS, a terminal on Windows -- which is
		// every redirected or captured run on those platforms.
		const result = await runAs("prime-agent", ["--version"]);

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("'prime-agent' is deprecated");
		expect(result.stderr).toContain(VERSION);
		expect(result.stdout).toBe("");
	}, 120_000);

	it("says nothing under the canonical name", async () => {
		const result = await runAs("wasmedge-agent", ["doctor", "--json"]);

		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain("deprecated");
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	}, 120_000);
});

describe("deprecation warnings on an early-return command", () => {
	/** A legacy env name with a real reader that is consumed before any of
	 *  these commands returns: the agent directory is resolved at the top of
	 *  main(), by the one-time directory move. */
	function legacyAgentDirEnv(): NodeJS.ProcessEnv {
		const legacyDir = mkdtempSync(join(tmpdir(), "wasmedge-agent-legacy-env-"));
		tempDirs.push(legacyDir);
		return { WASMEDGE_AGENT_CODING_AGENT_DIR: undefined, PRIME_AGENT_CODING_AGENT_DIR: legacyDir };
	}

	it("reaches stderr from a public command, without touching its json stdout", async () => {
		// doctor returns from handlePublicCommand, far above the reporter that
		// normally shows these. The fallback worked and the user was never told.
		const result = await runAs("wasmedge-agent", ["doctor", "--json"], legacyAgentDirEnv());

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("PRIME_AGENT_CODING_AGENT_DIR is deprecated");
		expect(() => JSON.parse(result.stdout)).not.toThrow();
		expect(result.stdout).not.toContain("deprecated");
	}, 120_000);

	it("reaches stderr before --version returns", async () => {
		const result = await runAs("wasmedge-agent", ["--version"], legacyAgentDirEnv());

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("PRIME_AGENT_CODING_AGENT_DIR is deprecated");
		// The version itself is on stderr too, and was before this change:
		// takeOverStdout routes ordinary console output there for every
		// non-interactive mode, leaving stdout for protocol payloads only --
		// which is what the doctor --json case above checks.
		expect(result.stderr).toContain(VERSION);
		expect(result.stdout).toBe("");
	}, 120_000);
});

/** The harness's own contract. The test below asserts a property of a single
 *  run -- each warning exactly once -- and a harness that can finish before its
 *  driver does would report success on a run that proved nothing. Both cases
 *  settle the driver deliberately after the child has gone, which is the
 *  ordering that used to be lost. */
describe("run harness", () => {
	it("waits for the driver even when the child closes first", async () => {
		let droveAfterClose = false;

		const result = await runAs("wasmedge-agent", ["--mode", "rpc", "--no-session"], {}, async (session) => {
			session.close();
			// Ordered against the child's actual exit, not a guessed delay, so
			// this cannot pass by being quicker than the shutdown.
			await session.closed;
			await new Promise((settle) => setTimeout(settle, 50));
			droveAfterClose = true;
		});

		expect(droveAfterClose).toBe(true);
		expect(result.signal).toBeNull();
		expect(result.code).toBe(0);
	}, 120_000);

	it("keeps a driver failure that lands after the child closed", async () => {
		await expect(
			runAs("wasmedge-agent", ["--mode", "rpc", "--no-session"], {}, async (session) => {
				session.close();
				await session.closed;
				await new Promise((settle) => setTimeout(settle, 50));
				throw new Error("driver failed after close");
			}),
		).rejects.toThrow("driver failed after close");
	}, 120_000);
});

describe("deprecation warnings a non-interactive mode collects late", () => {
	it("reports a renamed theme once, on stderr, and still serves the protocol", async () => {
		// The theme alias is not resolved until initTheme(), which runs after
		// this mode's one deprecation report. Interactive mode has a second
		// pass and caught it; rpc, acp, print and the daemon client did not,
		// and accepted the old theme name in silence.
		const home = mkdtempSync(join(tmpdir(), "wasmedge-agent-theme-warn-"));
		tempDirs.push(home);
		const agentDir = join(home, "agent");
		const sessionDir = join(home, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "prime" }));

		let response: unknown;
		const result = await runAs(
			"wasmedge-agent",
			["--mode", "rpc", "--no-session"],
			{
				WASMEDGE_AGENT_CODING_AGENT_DIR: agentDir,
				// Read before the common report, so this exercises the other
				// side of the bookkeeping: two drains in one run, each message
				// once.
				PRIME_AGENT_SESSION_DIR: sessionDir,
			},
			async (session) => {
				session.send({ id: "state-1", type: "get_state" });
				response = JSON.parse(await session.nextStdoutLine((line) => line.includes('"state-1"')));
				// Ending stdin is how rpc is asked to shut down, so the exit
				// status below is a real one.
				session.close();
			},
		);

		// The mode did its job after the warning, and stopped on request.
		expect(response).toMatchObject({ id: "state-1", type: "response", command: "get_state", success: true });
		expect(result.signal).toBeNull();
		expect(result.code).toBe(0);

		// Every warning exactly once, over the whole run rather than up to the
		// first match -- a duplicate arriving later would show here.
		expect(occurrences(result.stderr, 'Theme "prime" was renamed')).toBe(1);
		expect(occurrences(result.stderr, "SESSION_DIR is deprecated")).toBe(1);

		// ...and stdout carried protocol data and nothing else.
		const stdoutLines = result.stdout.split("\n").filter((line) => line.trim() !== "");
		expect(stdoutLines.length).toBeGreaterThan(0);
		for (const line of stdoutLines) expect(() => JSON.parse(line)).not.toThrow();
		expect(result.stdout).not.toContain("deprecated");
	}, 120_000);
});

describe("deprecation warnings on a failing startup", () => {
	/** Both agent directories present, which is the state the never-clobber
	 *  rule leaves and the one warning a user most needs: everything they have
	 *  is in the legacy tree and the command just run read the empty new one. */
	function bothAgentDirectories(): NodeJS.ProcessEnv {
		const base = mkdtempSync(join(tmpdir(), "wasmedge-agent-both-dirs-"));
		tempDirs.push(base);
		mkdirSync(join(base, ".prime", "agent"), { recursive: true });
		mkdirSync(join(base, "agent"), { recursive: true });
		return { HOME: base, USERPROFILE: base, WASMEDGE_AGENT_CODING_AGENT_DIR: join(base, "agent") };
	}

	it.each([
		["a bare --resume", ["--resume"]],
		["an unusable --cwd", ["--cwd", "/wasmedge-agent-no-such-directory"]],
	])(
		"reports what startup collected before it fails on %s",
		async (_name, args) => {
			const result = await runAs("wasmedge-agent", args, bothAgentDirectories());

			// The command still fails, and says why.
			expect(result.signal).toBeNull();
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Error:");
			// ...and the user is told where their configuration actually is.
			expect(occurrences(result.stderr, "both exist, so nothing was migrated")).toBe(1);
			expect(result.stderr).toContain(".prime/agent");
			expect(result.stdout).toBe("");
		},
		120_000,
	);

	it("reports them when an interactive fork fails before the TUI can show them", async () => {
		// The failure exits from inside forkSessionOrExit, which lives in the
		// exported createSessionManager -- so main() has to hand that function
		// the reporting exit rather than have it reach for one.
		const result = await runAs(
			"wasmedge-agent",
			["--fork", "/wasmedge-agent-no-such-directory/session.jsonl"],
			{ ...bothAgentDirectories(), PI_STARTUP_BENCHMARK: "1" },
			undefined,
			{ interactive: true },
		);

		expect(result.signal).toBeNull();
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Error:");
		expect(occurrences(result.stderr, "both exist, so nothing was migrated")).toBe(1);
	}, 120_000);

	it("reports them once, not twice, when a stored session working directory is gone", async () => {
		// Non-interactive, so the mode-level reporter has already written these
		// by the time this exit runs. The exit reports again through the
		// run-level record of what has been written, and this is what pins that
		// the record really does suppress the repeat.
		const env = bothAgentDirectories();
		const agentDir = env.WASMEDGE_AGENT_CODING_AGENT_DIR as string;
		const sessionsDir = join(agentDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = join(sessionsDir, "gone-cwd.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "gone-cwd",
				timestamp: new Date().toISOString(),
				cwd: "/wasmedge-agent-no-such-directory",
			})}\n`,
		);

		const result = await runAs("wasmedge-agent", ["--resume", sessionFile], env);

		expect(result.signal).toBeNull();
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Stored session working directory does not exist");
		expect(occurrences(result.stderr, "both exist, so nothing was migrated")).toBe(1);
	}, 120_000);

	it("reports them when an @file argument names a file that is not there", async () => {
		// The @file read happens below the point where interactive mode decides
		// to hold its warnings back for the TUI, and a missing file means that
		// TUI never opens. processFileArguments used to exit the process itself
		// here, so the whole set went with it.
		const result = await runAs(
			"wasmedge-agent",
			["@/wasmedge-agent-no-such-directory/prompt.md"],
			{
				...bothAgentDirectories(),
				// Same reason as the --resume test above: keeps the failure in
				// this process instead of handing the run to a daemon.
				PI_STARTUP_BENCHMARK: "1",
			},
			undefined,
			{ interactive: true },
		);

		expect(result.signal).toBeNull();
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("File not found");
		expect(occurrences(result.stderr, "both exist, so nothing was migrated")).toBe(1);
		expect(result.stdout).toBe("");
	}, 120_000);

	// chmod cannot deny root, and Windows ignores the mode bits entirely.
	const modeBitsDenyReads = process.platform !== "win32" && process.getuid?.() !== 0;

	(modeBitsDenyReads ? it : it.skip)(
		"reports them when an @file argument names a file it cannot read",
		async () => {
			// The other half of the same exit, and the half that got away: this
			// file exists, so access() succeeds, and the failure lands inside MIME
			// detection -- which opens every nonempty file before the text read is
			// reached. That error was not a FileArgumentError, so it went straight
			// past prepareInitialMessage's instanceof check and took the warnings
			// with it.
			const env = bothAgentDirectories();
			const unreadable = join(env.HOME as string, "unreadable.md");
			writeFileSync(unreadable, "# not for you\n", { mode: 0o000 });

			const result = await runAs(
				"wasmedge-agent",
				[`@${unreadable}`],
				{ ...env, PI_STARTUP_BENCHMARK: "1" },
				undefined,
				{ interactive: true },
			);

			expect(result.signal).toBeNull();
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Could not read file");
			expect(occurrences(result.stderr, "both exist, so nothing was migrated")).toBe(1);
			expect(result.stdout).toBe("");
		},
		120_000,
	);

	it("reports them when interactive startup fails before the TUI can show them", async () => {
		// Interactive mode skips the reporter every other mode gets, because
		// it means to show these inside the TUI. An invalid --resume selector
		// exits between those two points, so the warning that says where the
		// user's configuration actually is was collected and then dropped.
		const result = await runAs(
			"wasmedge-agent",
			["--resume", "no-such-session-selector"],
			{
				...bothAgentDirectories(),
				// Keeps the failure in this process. It is the flag both
				// shouldUseDaemonClientRuntime and maybeStartDaemonEarly test, so
				// setting it means no daemon is spawned and the run reaches the
				// session-selector failure directly.
				PI_STARTUP_BENCHMARK: "1",
			},
			undefined,
			{ interactive: true },
		);

		expect(result.signal).toBeNull();
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("No session found matching");
		// Exactly once, over the whole run: the interactive path must not
		// gain a second reporter that repeats what this one wrote.
		expect(occurrences(result.stderr, "both exist, so nothing was migrated")).toBe(1);
	}, 120_000);
});
