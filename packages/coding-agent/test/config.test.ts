import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, it, test } from "vitest";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	detectInstallMethod,
	ENV_AGENT_DIR,
	ENV_LEGACY_SESSION_DIR,
	ENV_SESSION_DIR,
	getProjectConfigDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getSessionsDir,
	getUpdateInstruction,
	LEGACY_ALIAS_ENV,
	LEGACY_NAME_WARNINGS,
	readLegacyEnv,
	warnIfLegacyAlias,
	withCurrentLegacyWarnings,
} from "../src/config.js";
import { getDefaultSessionDir } from "../src/core/session-manager.js";

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
const originalPath = process.env.PATH;
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
const originalSessionDir = process.env[ENV_SESSION_DIR];
const originalLegacySessionDir = process.env[ENV_LEGACY_SESSION_DIR];
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalPiPackageDir === undefined) {
		delete process.env.PI_PACKAGE_DIR;
	} else {
		process.env.PI_PACKAGE_DIR = originalPiPackageDir;
	}
	if (originalSessionDir === undefined) {
		delete process.env[ENV_SESSION_DIR];
	} else {
		process.env[ENV_SESSION_DIR] = originalSessionDir;
	}
	if (originalLegacySessionDir === undefined) {
		delete process.env[ENV_LEGACY_SESSION_DIR];
	} else {
		process.env[ENV_LEGACY_SESSION_DIR] = originalLegacySessionDir;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "pi-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(
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
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@mariozechner", "pi-coding-agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.PI_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@earendil-works+pi-coding-agent@0.67.68\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Run: pnpm install -g @earendil-works/pi-coding-agent",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@earendil-works/pi-coding-agent"],
			display: `npm --prefix ${prefix} install -g @earendil-works/pi-coding-agent`,
		});
	});

	test("self-updates renamed packages from the current install prefix", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@new-scope/pi"],
			display: `npm --prefix ${prefix} uninstall -g @mariozechner/pi-coding-agent && npm --prefix ${prefix} install -g @new-scope/pi`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: `npm --prefix ${prefix} uninstall -g @mariozechner/pi-coding-agent`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "install", "-g", "@new-scope/pi"],
					display: `npm --prefix ${prefix} install -g @new-scope/pi`,
				},
			],
		});
	});

	test("self-updates tarball specs without uninstalling the same logical package first", () => {
		const { prefix } = createNpmPrefixInstall();
		const tarballUrl = "https://downloads.example.test/wasmedge-agent/wasmedge-agent-0.73.0.tgz";

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", undefined, tarballUrl);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", tarballUrl],
			display: `npm --prefix ${prefix} install -g ${tarballUrl}`,
		});
	});

	test("self-updates renamed tarball packages by uninstalling the old package after install", () => {
		const { prefix } = createNpmPrefixInstall();
		const tarballUrl = "https://downloads.example.test/wasmedge-agent/wasmedge-agent-0.73.0.tgz";

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", undefined, tarballUrl, "wasmedge-agent");

		expect(command).toEqual({
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

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@earendil-works/pi-coding-agent"],
			display: `npm --prefix ${prefix} install -g @earendil-works/pi-coding-agent`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent", []);

		expect(command?.args).toEqual(["--prefix", prefix, "install", "-g", "@earendil-works/pi-coding-agent"]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("pi prefix ");

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(command?.display).toBe(`npm --prefix "${prefix}" install -g @earendil-works/pi-coding-agent`);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@earendil-works\\pi-coding-agent";
		process.env.PI_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Run: npm install -g @earendil-works/pi-coding-agent",
		);
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@earendil-works/pi-coding-agent"],
			display: "bun install -g @earendil-works/pi-coding-agent",
		});
	});

	test("self-updates renamed pnpm global installs by removing the old package first", () => {
		createPnpmGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "@new-scope/pi"],
			display: "pnpm remove -g @mariozechner/pi-coding-agent && pnpm install -g @new-scope/pi",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@mariozechner/pi-coding-agent"],
					display: "pnpm remove -g @mariozechner/pi-coding-agent",
				},
				{
					command: "pnpm",
					args: ["install", "-g", "@new-scope/pi"],
					display: "pnpm install -g @new-scope/pi",
				},
			],
		});
	});

	test("self-updates renamed yarn global installs by removing the old package first", () => {
		createYarnGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "@new-scope/pi"],
			display: "yarn global remove @mariozechner/pi-coding-agent && yarn global add @new-scope/pi",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@mariozechner/pi-coding-agent"],
					display: "yarn global remove @mariozechner/pi-coding-agent",
				},
				{
					command: "yarn",
					args: ["global", "add", "@new-scope/pi"],
					display: "yarn global add @new-scope/pi",
				},
			],
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@new-scope/pi"],
			display: "bun uninstall -g @mariozechner/pi-coding-agent && bun install -g @new-scope/pi",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: "bun uninstall -g @mariozechner/pi-coding-agent",
				},
				{
					command: "bun",
					args: ["install", "-g", "@new-scope/pi"],
					display: "bun install -g @new-scope/pi",
				},
			],
		});
	});

	test("does not self-update when npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toContain(
			"the install path is not writable",
		);
	});
});

describe("session paths", () => {
	test("uses the short app-prefixed session dir env var", () => {
		expect(ENV_SESSION_DIR).toBe("WASMEDGE_AGENT_SESSION_DIR");
	});

	test("uses the session root env var when computing sessions dir", () => {
		const sessionRoot = join(tmpdir(), `pi-session-root-${Date.now()}`);
		process.env[ENV_SESSION_DIR] = sessionRoot;

		expect(getSessionsDir("/agent")).toBe(sessionRoot);
	});

	test("uses the legacy coding agent session root env var when the new env var is unset", () => {
		const sessionRoot = join(tmpdir(), `pi-legacy-session-root-${Date.now()}`);
		delete process.env[ENV_SESSION_DIR];
		process.env[ENV_LEGACY_SESSION_DIR] = sessionRoot;

		expect(getSessionsDir("/agent")).toBe(sessionRoot);
	});

	test("expands tilde in the session root env var", () => {
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

	test("uses the env session root as the default session dir", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-root-"));
		const cwd = join(tempDir, "project");
		const sessionRoot = join(tempDir, "sessions-root");
		process.env[ENV_SESSION_DIR] = sessionRoot;

		const sessionDir = getDefaultSessionDir(cwd, join(tempDir, "agent"));

		expect(sessionDir).toBe(sessionRoot);
	});
});

describe("legacy env fallback", () => {
	afterEach(() => {
		delete process.env.WASMEDGE_AGENT_CODING_AGENT_DIR;
		delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
		LEGACY_NAME_WARNINGS.length = 0;
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
