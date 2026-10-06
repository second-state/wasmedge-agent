import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, it, test } from "vitest";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	collectLegacyEnvDeprecations,
	detectInstallMethod,
	ENV_AGENT_DIR,
	ENV_LEGACY_SESSION_DIR,
	ENV_SESSION_DIR,
	getDaemonLogPath,
	getProjectConfigDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getSessionsDir,
	LEGACY_ALIAS_ENV,
	LEGACY_NAME_WARNINGS,
	readLegacyEnv,
	resetLegacyNameWarnings,
	warnIfLegacyAlias,
	withCurrentLegacyWarnings,
} from "../src/config.js";

/** These are the whole point of the rebrand, and every one is derived from
 *  package.json's piConfig at import time rather than written down anywhere.
 *  check-branding catches a revert to the old literals but not a typo in the
 *  new ones -- ".wasmedge_agent" or "wasmedge-agents" would sail past it while
 *  silently relocating every user's config. Pin the values. */
describe("application identity", () => {
	test("resolves the WasmEdge Agent identity from piConfig", () => {
		expect(APP_NAME).toBe("wasmedge-agent");
		expect(APP_TITLE).toBe("wasmedge-agent");
		expect(CONFIG_DIR_NAME).toBe(".wasmedge-agent");
	});

	test("derives the env prefix from the application name", () => {
		expect(ENV_AGENT_DIR).toBe("WASMEDGE_AGENT_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("WASMEDGE_AGENT_SESSION_DIR");
		expect(ENV_LEGACY_SESSION_DIR).toBe("WASMEDGE_AGENT_CODING_AGENT_SESSION_DIR");
	});
});

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalEnv = {
	PATH: process.env.PATH,
	PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
	[ENV_SESSION_DIR]: process.env[ENV_SESSION_DIR],
	[ENV_LEGACY_SESSION_DIR]: process.env[ENV_LEGACY_SESSION_DIR],
};
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", { value, configurable: true });
}

afterEach(() => {
	if (execPathDescriptor) Object.defineProperty(process, "execPath", execPathDescriptor);
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

// Fake package-manager CLI that answers one argv probe (`pnpm root -g`, `yarn global dir`, `bun pm bin -g`).
function writeFakeCli(binDir: string, name: string, probe: string[], output: string): void {
	mkdirSync(binDir, { recursive: true });
	const isWindows = process.platform === "win32";
	const file = join(binDir, isWindows ? `${name}.cmd` : name);
	const script = isWindows
		? `@echo off\r\n${probe.map((arg, index) => `if "%${index + 1}"=="${arg}" `).join("")}echo ${output}\r\n`
		: `#!/bin/sh\nif ${probe
				.map((arg, index) => `[ "$${index + 1}" = "${arg}" ]`)
				.join(" && ")}; then\n\tprintf '%s\\n' '${output.replaceAll("'", "'\\''")}'\n\texit 0\nfi\nexit 1\n`;
	writeFileSync(file, script);
	chmodSync(file, 0o755);
	process.env.PATH = `${binDir}${delimiter}${originalEnv.PATH ?? ""}`;
}

function usePackageDir(packageDir: string, execPath = join(packageDir, "dist", "cli.js")): void {
	mkdirSync(packageDir, { recursive: true });
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(execPath);
}

function createNpmPrefixInstall(template = "pi-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const packageDir = join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
	tempDir = prefix;
	usePackageDir(packageDir);
	return { prefix, packageDir };
}

function createHomebrewInstall(): void {
	const prefix = mkdtempSync(join(tmpdir(), "pi-homebrew-"));
	tempDir = prefix;
	usePackageDir(join(prefix, "Cellar", "wasmedge-agent", "0.7.0", "libexec", "lib", "node_modules", "wasmedge-agent"));
}

function createPnpmGlobalInstall(): void {
	const temp = mkdtempSync(join(tmpdir(), "pi-pnpm-"));
	tempDir = temp;
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@mariozechner", "pi-coding-agent");
	writeFakeCli(join(temp, "bin"), "pnpm", ["root", "-g"], root);
	usePackageDir(
		packageDir,
		join(
			root,
			".pnpm",
			"@mariozechner+pi-coding-agent@0.0.0",
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
			"dist",
			"cli.js",
		),
	);
}

function createYarnGlobalInstall(): void {
	const temp = mkdtempSync(join(tmpdir(), "pi-yarn-"));
	tempDir = temp;
	const globalDir = join(temp, "yarn", "global");
	writeFakeCli(join(temp, "bin"), "yarn", ["global", "dir"], globalDir);
	usePackageDir(
		join(globalDir, "node_modules", "@mariozechner", "pi-coding-agent"),
		join(globalDir, ".yarn", "@mariozechner", "pi-coding-agent", "dist", "cli.js"),
	);
}

function createBunGlobalInstall(): void {
	const temp = mkdtempSync(join(tmpdir(), "pi-bun-"));
	tempDir = temp;
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	writeFakeCli(bunBin, "bun", ["pm", "bin", "-g"], bunBin);
	usePackageDir(join(prefix, "install", "global", "node_modules", "@earendil-works", "pi-coding-agent"));
}

describe("detectInstallMethod", () => {
	// Misdetecting the install method breaks self-update: it runs the wrong package manager.
	test.each<[string, () => void, string]>([
		[
			"Windows .pnpm install paths",
			() =>
				setExecPath(
					"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@earendil-works+pi-coding-agent@0.67.68\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
				),
			"pnpm",
		],
		[
			"Windows npm package dirs",
			() => {
				const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@earendil-works\\pi-coding-agent";
				process.env.PI_PACKAGE_DIR = packageDir;
				setExecPath(`${packageDir}\\dist\\cli.js`);
			},
			"npm",
		],
		["npm custom prefixes", () => createNpmPrefixInstall(), "npm"],
		["pnpm global installs", () => createPnpmGlobalInstall(), "pnpm"],
		["yarn global installs", () => createYarnGlobalInstall(), "yarn"],
		["bun global installs", () => createBunGlobalInstall(), "bun"],
		["Homebrew installs", () => createHomebrewInstall(), "homebrew"],
		["unknown wrapper installs", () => setExecPath("/usr/local/bin/node"), "unknown"],
	])("detects %s", (_label, setup, expected) => {
		setup();
		expect(detectInstallMethod()).toBe(expected);
	});

	test.each<[string, () => void]>([
		["Homebrew", () => createHomebrewInstall()],
		["unknown wrappers", () => setExecPath("/usr/local/bin/node")],
	])("refuses to self-update %s installs", (_label, setup) => {
		setup();
		expect(getSelfUpdateCommand("wasmedge-agent")).toBeUndefined();
	});

	test("does not self-update when the npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toContain(
			"the install path is not writable",
		);
	});

	test.each<[string, (prefix: string) => string[] | undefined]>([
		["defaults to the detected prefix", () => undefined],
		["respects a configured npmCommand", (prefix) => ["npm", "--prefix", prefix]],
		["treats an empty npmCommand as unset", () => []],
	])("npm self-update %s", (_label, npmCommand) => {
		const { prefix } = createNpmPrefixInstall();

		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent", npmCommand(prefix))).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@earendil-works/pi-coding-agent"],
			display: `npm --prefix ${prefix} install -g @earendil-works/pi-coding-agent`,
		});
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("pi prefix ");

		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")?.display).toBe(
			`npm --prefix "${prefix}" install -g @earendil-works/pi-coding-agent`,
		);
	});

	const tarballUrl = "https://downloads.example.test/wasmedge-agent/wasmedge-agent-0.73.0.tgz";

	test("installs a tarball spec without uninstalling the same logical package", () => {
		const { prefix } = createNpmPrefixInstall();

		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent", undefined, tarballUrl)).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", tarballUrl],
			display: `npm --prefix ${prefix} install -g ${tarballUrl}`,
		});
	});

	test("installs a renamed tarball package before uninstalling the old one", () => {
		const { prefix } = createNpmPrefixInstall();

		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent", undefined, tarballUrl, "wasmedge-agent")).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", tarballUrl],
			display: `npm --prefix ${prefix} install -g ${tarballUrl} && npm --prefix ${prefix} uninstall -g @earendil-works/pi-coding-agent`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "install", "-g", tarballUrl],
					display: `npm --prefix ${prefix} install -g ${tarballUrl}`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@earendil-works/pi-coding-agent"],
					display: `npm --prefix ${prefix} uninstall -g @earendil-works/pi-coding-agent`,
				},
			],
		});
	});

	// A rename must remove the old global package first, with each manager's own remove verb.
	test.each<[string, () => string[], string, string[], string[]]>([
		["npm", () => ["--prefix", createNpmPrefixInstall().prefix], "npm", ["uninstall", "-g"], ["install", "-g"]],
		[
			"pnpm",
			() => {
				createPnpmGlobalInstall();
				return [];
			},
			"pnpm",
			["remove", "-g"],
			["install", "-g"],
		],
		[
			"yarn",
			() => {
				createYarnGlobalInstall();
				return [];
			},
			"yarn",
			["global", "remove"],
			["global", "add"],
		],
		[
			"bun",
			() => {
				createBunGlobalInstall();
				return [];
			},
			"bun",
			["uninstall", "-g"],
			["install", "-g"],
		],
	])("renames a %s global install by removing the old package first", (_label, setup, command, remove, install) => {
		const argPrefix = setup();

		const result = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(result?.command).toBe(command);
		expect(result?.steps?.map((step) => ({ command: step.command, args: step.args }))).toEqual([
			{ command, args: [...argPrefix, ...remove, "@mariozechner/pi-coding-agent"] },
			{ command, args: [...argPrefix, ...install, "@new-scope/pi"] },
		]);
	});
});

describe("session paths", () => {
	test("prefers the app-prefixed session dir env var over the legacy one and expands tilde", () => {
		expect(ENV_SESSION_DIR).toBe("WASMEDGE_AGENT_SESSION_DIR");

		const sessionRoot = join(tmpdir(), `pi-session-root-${Date.now()}`);
		process.env[ENV_SESSION_DIR] = sessionRoot;
		process.env[ENV_LEGACY_SESSION_DIR] = join(tmpdir(), "legacy-root");
		expect(getSessionsDir("/agent")).toBe(sessionRoot);

		delete process.env[ENV_SESSION_DIR];
		expect(getSessionsDir("/agent")).toBe(join(tmpdir(), "legacy-root"));

		process.env[ENV_SESSION_DIR] = "~/wasmedge-agent-sessions";
		expect(getSessionsDir("/agent")).toBe(join(homedir(), "wasmedge-agent-sessions"));
	});

	test("prefers a current long name over the deprecated short one", () => {
		// The collision the pair-by-pair resolution got wrong: both are set,
		// one is a name we still support and one is a name we are asking
		// people to drop, and the deprecated one used to win.
		const current = join(tmpdir(), `current-session-root-${Date.now()}`);
		const legacy = join(tmpdir(), `legacy-session-root-${Date.now()}`);
		delete process.env[ENV_SESSION_DIR];
		process.env[ENV_LEGACY_SESSION_DIR] = current;
		process.env.PRIME_AGENT_SESSION_DIR = legacy;

		try {
			expect(getSessionsDir("/agent")).toBe(current);
		} finally {
			delete process.env.PRIME_AGENT_SESSION_DIR;
		}
	});

	test("falls back to the deprecated short name when no current name is set", () => {
		const legacy = join(tmpdir(), `legacy-only-root-${Date.now()}`);
		delete process.env[ENV_SESSION_DIR];
		delete process.env[ENV_LEGACY_SESSION_DIR];
		process.env.PRIME_AGENT_SESSION_DIR = legacy;

		try {
			expect(getSessionsDir("/agent")).toBe(legacy);
			expect(LEGACY_NAME_WARNINGS.some((warning) => warning.includes("PRIME_AGENT_SESSION_DIR"))).toBe(true);
		} finally {
			delete process.env.PRIME_AGENT_SESSION_DIR;
			LEGACY_NAME_WARNINGS.length = 0;
		}
	});

	test("keeps the short name ahead of the long one among the deprecated names", () => {
		const shortName = join(tmpdir(), `legacy-short-root-${Date.now()}`);
		const longName = join(tmpdir(), `legacy-long-root-${Date.now()}`);
		delete process.env[ENV_SESSION_DIR];
		delete process.env[ENV_LEGACY_SESSION_DIR];
		process.env.PRIME_AGENT_SESSION_DIR = shortName;
		process.env.PRIME_AGENT_CODING_AGENT_SESSION_DIR = longName;

		try {
			expect(getSessionsDir("/agent")).toBe(shortName);
		} finally {
			delete process.env.PRIME_AGENT_SESSION_DIR;
			delete process.env.PRIME_AGENT_CODING_AGENT_SESSION_DIR;
			LEGACY_NAME_WARNINGS.length = 0;
		}
	});
});

describe("getDaemonLogPath", () => {
	test("normalizes POSIX socket path spellings to one log file", () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			expect(getDaemonLogPath("/a//b.sock")).toBe(getDaemonLogPath("/a/b.sock"));
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});
});

describe("legacy env fallback", () => {
	afterEach(() => {
		delete process.env.WASMEDGE_AGENT_CODING_AGENT_DIR;
		delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
		delete process.env.PRIME_AGENT_TRACES_API_KEY;
		delete process.env.PRIME_AGENT_WEBSEARCH_TIMEOUT;
		LEGACY_NAME_WARNINGS.length = 0;
	});

	/** Names whose only reader runs long after the startup drain: the websearch
	 *  settings a tool call resolves, and the trace credential an upload does.
	 *  Their fallback worked, and their deprecation was queued behind a reporter
	 *  that had already run. */
	it("collects a legacy name nothing reads until later in the session", () => {
		process.env.PRIME_AGENT_TRACES_API_KEY = "legacy-key";
		process.env.PRIME_AGENT_WEBSEARCH_TIMEOUT = "30";

		collectLegacyEnvDeprecations();

		const collected = LEGACY_NAME_WARNINGS.join("\n");
		expect(collected).toContain("PRIME_AGENT_TRACES_API_KEY");
		expect(collected).toContain("WASMEDGE_AGENT_TRACES_API_KEY");
		expect(collected).toContain("PRIME_AGENT_WEBSEARCH_TIMEOUT");
	});

	it("says nothing about a legacy name that is not set", () => {
		collectLegacyEnvDeprecations();

		expect(LEGACY_NAME_WARNINGS.join("\n")).not.toContain("PRIME_AGENT_TRACES_API_KEY");
	});

	it("does not collect a legacy name the current one already answers", () => {
		process.env.WASMEDGE_AGENT_TRACES_API_KEY = "current-key";
		process.env.PRIME_AGENT_TRACES_API_KEY = "legacy-key";
		try {
			collectLegacyEnvDeprecations();

			expect(LEGACY_NAME_WARNINGS.join("\n")).not.toContain("PRIME_AGENT_TRACES_API_KEY");
		} finally {
			delete process.env.WASMEDGE_AGENT_TRACES_API_KEY;
		}
	});

	it("empties the collection for a fresh run", () => {
		process.env.PRIME_AGENT_CODING_AGENT_DIR = "/example/legacy";
		readLegacyEnv("WASMEDGE_AGENT_CODING_AGENT_DIR");
		expect(LEGACY_NAME_WARNINGS).toHaveLength(1);

		resetLegacyNameWarnings();

		expect(LEGACY_NAME_WARNINGS).toHaveLength(0);
	});

	it("reads the legacy name when the current one is unset, and warns once", () => {
		process.env.PRIME_AGENT_CODING_AGENT_DIR = "/example/legacy";
		expect(readLegacyEnv("WASMEDGE_AGENT_CODING_AGENT_DIR")).toBe("/example/legacy");
		readLegacyEnv("WASMEDGE_AGENT_CODING_AGENT_DIR");
		expect(LEGACY_NAME_WARNINGS).toHaveLength(1);
		expect(LEGACY_NAME_WARNINGS[0]).toContain("PRIME_AGENT_CODING_AGENT_DIR");
	});

	it("prefers the current name and does not warn when both are set", () => {
		process.env.WASMEDGE_AGENT_CODING_AGENT_DIR = "/example/new";
		process.env.PRIME_AGENT_CODING_AGENT_DIR = "/example/legacy";
		expect(readLegacyEnv("WASMEDGE_AGENT_CODING_AGENT_DIR")).toBe("/example/new");
		expect(LEGACY_NAME_WARNINGS).toHaveLength(0);
	});

	it("returns undefined when neither is set", () => {
		expect(readLegacyEnv("WASMEDGE_AGENT_CODING_AGENT_DIR")).toBeUndefined();
		expect(LEGACY_NAME_WARNINGS).toHaveLength(0);
	});

	it("has no legacy mapping for internal or test variables", () => {
		process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER = "1";
		expect(readLegacyEnv("WASMEDGE_AGENT_INTERNAL_DAEMON_WORKER")).toBeUndefined();
		delete process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER;
	});
});

describe("legacy command alias", () => {
	afterEach(() => {
		delete process.env[LEGACY_ALIAS_ENV];
	});

	it("warns when invoked through the legacy name", () => {
		const written: string[] = [];
		expect(warnIfLegacyAlias("/usr/local/bin/prime-agent", (m) => written.push(m))).toBe(true);
		expect(written).toHaveLength(1);
		expect(written[0]).toContain("wasmedge-agent");
		expect(written[0].endsWith("\n")).toBe(true);
	});

	it("warns when the packed alias entry point marks the invocation", () => {
		// What a Windows install looks like: npm's .cmd and PowerShell shims
		// launch node with the target path, so argv[1] names the canonical
		// entry and the marker is the only evidence of the invoked name.
		const written: string[] = [];
		process.env[LEGACY_ALIAS_ENV] = "1";

		expect(warnIfLegacyAlias("C:\\node_modules\\wasmedge-agent\\dist\\bundle\\cli.js", (m) => written.push(m))).toBe(
			true,
		);

		expect(written).toHaveLength(1);
		expect(written[0]).toContain("wasmedge-agent");
	});

	it("consumes the marker so no child can repeat the notice", () => {
		// Every child inherits process.env and runs this same code -- daemon
		// workers, owned session workers, an update relaunch. A marker left
		// behind turns one invocation into one notice per child.
		const written: string[] = [];
		process.env[LEGACY_ALIAS_ENV] = "1";

		expect(warnIfLegacyAlias("/usr/local/bin/wasmedge-agent", (m) => written.push(m))).toBe(true);
		expect(process.env[LEGACY_ALIAS_ENV]).toBeUndefined();

		// The second call stands in for the child that would have inherited it.
		expect(warnIfLegacyAlias("/usr/local/bin/wasmedge-agent", (m) => written.push(m))).toBe(false);
		expect(written).toHaveLength(1);
	});

	it("says nothing under the canonical name", () => {
		const written: string[] = [];
		expect(warnIfLegacyAlias("/usr/local/bin/wasmedge-agent", (m) => written.push(m))).toBe(false);
		expect(written).toHaveLength(0);
	});

	it("says nothing for an empty argv[1]", () => {
		const written: string[] = [];
		expect(warnIfLegacyAlias("", (m) => written.push(m))).toBe(false);
		expect(written).toHaveLength(0);
	});
});

describe("project-local config dir", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		LEGACY_NAME_WARNINGS.length = 0;
	});

	function project(): string {
		const dir = mkdtempSync(join(tmpdir(), "wasmedge-project-"));
		dirs.push(dir);
		return dir;
	}

	it("prefers the current directory when it exists", () => {
		const cwd = project();
		mkdirSync(join(cwd, ".wasmedge-agent"), { recursive: true });
		mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
		expect(getProjectConfigDir(cwd)).toBe(join(cwd, ".wasmedge-agent"));
		expect(LEGACY_NAME_WARNINGS).toHaveLength(0);
	});

	it("falls back to the legacy directory and warns once", () => {
		const cwd = project();
		mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
		expect(getProjectConfigDir(cwd)).toBe(join(cwd, ".prime", "agent"));
		getProjectConfigDir(cwd);
		expect(LEGACY_NAME_WARNINGS).toHaveLength(1);
		expect(LEGACY_NAME_WARNINGS[0]).toContain(".prime");
	});

	it("returns the current directory when neither exists, without warning", () => {
		const cwd = project();
		expect(getProjectConfigDir(cwd)).toBe(join(cwd, ".wasmedge-agent"));
		expect(LEGACY_NAME_WARNINGS).toHaveLength(0);
	});
});

describe("withCurrentLegacyWarnings", () => {
	afterEach(() => {
		LEGACY_NAME_WARNINGS.length = 0;
	});

	it("returns the snapshot unchanged when nothing new was pushed since it was taken", () => {
		LEGACY_NAME_WARNINGS.push("warning A");
		const snapshot = ["warning A", "unrelated extension warning"];
		expect(withCurrentLegacyWarnings(snapshot)).toEqual(snapshot);
	});

	it("includes a warning pushed into LEGACY_NAME_WARNINGS after the snapshot was taken", () => {
		const snapshot = ["warning A", "unrelated extension warning"];
		LEGACY_NAME_WARNINGS.push("warning A");
		// Simulates a late push -- e.g. a --resume session in a different
		// project's cwd -- that happens after the snapshot array already
		// exists but before the fresh union is computed.
		LEGACY_NAME_WARNINGS.push("late warning B");
		const result = withCurrentLegacyWarnings(snapshot);
		expect(result).toContain("late warning B");
		expect(result).toContain("unrelated extension warning");
	});

	it("never duplicates an entry the snapshot and LEGACY_NAME_WARNINGS both carry", () => {
		LEGACY_NAME_WARNINGS.push("warning A");
		const snapshot = ["warning A"];
		const result = withCurrentLegacyWarnings(snapshot);
		expect(result).toEqual(["warning A"]);
	});

	it("returns an empty array when neither side has anything", () => {
		expect(withCurrentLegacyWarnings([])).toEqual([]);
	});
});
