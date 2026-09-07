import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getBinDir, LEGACY_NAME_WARNINGS } from "../src/config.js";

// postinstall.ts runs under `npm install -g`, in a process that never reaches
// main(). Everything it does resolves the agent directory, so this file's
// whole subject is what happens before that.

// homedir() is where the legacy path comes from; pointing it at a temp tree is
// the only way to exercise the wire-up without touching a real home directory.
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>();
	return { ...actual, homedir: vi.fn(actual.homedir) };
});

// Stands in for the real tools-manager, which reaches GitHub before it writes
// anything. The one behaviour under test is the one it shares with the real
// module: ensureTool() mkdir -p's getBinDir() -- ~/.wasmedge-agent/bin -- and
// so brings the new agent directory into existence as a side effect. If the
// migration has not already run by then, the never-clobber rule refuses the
// move for good.
vi.mock("../src/utils/tools-manager.js", () => ({
	ensureTool: vi.fn(async () => {
		mkdirSync(getBinDir(), { recursive: true });
		return { status: "unavailable", reason: "download_failed", platform: "linux", architecture: "x64" };
	}),
}));

// Not under test here, and importing the real module pulls in the whole cell
// runtime; WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL stays unset so neither runs.
vi.mock("../src/core/rust-cell/index.js", () => ({
	ensureTemplateReady: vi.fn(),
	resolveToolchain: vi.fn(() => ({ cargoBin: "cargo" })),
}));

describe("postinstall agent-dir ordering", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousBootstrapTools = process.env.WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL;
	const previousBootstrapRuntime = process.env.WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL;

	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		vi.mocked(homedir).mockReset();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		if (previousBootstrapTools === undefined) delete process.env.WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL;
		else process.env.WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = previousBootstrapTools;
		if (previousBootstrapRuntime === undefined) delete process.env.WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL;
		else process.env.WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL = previousBootstrapRuntime;
		LEGACY_NAME_WARNINGS.length = 0;
	});

	it("migrates the legacy agent dir before ensureTool can create the bin directory", async () => {
		const base = mkdtempSync(join(tmpdir(), "wasmedge-postinstall-"));
		tempDirs.push(base);
		const legacy = join(base, ".prime", "agent");
		const target = join(base, ".wasmedge-agent");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "auth.json"), '{"anthropic":{}}');
		vi.mocked(homedir).mockReturnValue(base);
		process.env[ENV_AGENT_DIR] = target;
		process.env.WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = "1";
		delete process.env.WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL;

		await import("../src/postinstall.js");

		// The bin directory was created, so ensureTool really ran...
		expect(existsSync(join(target, "bin"))).toBe(true);
		// ...and the migration got there first: the credentials moved instead of
		// being stranded in a legacy tree the CLI would never look at again.
		expect(readFileSync(join(target, "auth.json"), "utf-8")).toBe('{"anthropic":{}}');
		expect(existsSync(legacy)).toBe(false);
	});

	it("reports the both-directories warning it collects", async () => {
		// This process never reaches main(), so main()'s reporter never runs
		// for it. Without a drain of its own the never-clobber rule is silent
		// here, and `npm install -g` is what creates the state it describes.
		const base = mkdtempSync(join(tmpdir(), "wasmedge-postinstall-"));
		tempDirs.push(base);
		const legacy = join(base, ".prime", "agent");
		const target = join(base, ".wasmedge-agent");
		mkdirSync(legacy, { recursive: true });
		mkdirSync(target, { recursive: true });
		vi.mocked(homedir).mockReturnValue(base);
		process.env[ENV_AGENT_DIR] = target;
		process.env.WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = "1";
		delete process.env.WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL;
		const written: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});

		try {
			await import("../src/postinstall.js");
		} finally {
			stderrSpy.mockRestore();
		}

		const reported = written.join("");
		expect(reported).toContain(legacy);
		expect(reported).toContain(target);
		// Reported once, not once per drain point.
		expect(written.filter((line) => line.includes("both exist"))).toHaveLength(1);
		// The legacy tree is still there, untouched, which is what the warning
		// exists to tell the user.
		expect(existsSync(legacy)).toBe(true);
	});

	it("reports a legacy bootstrap variable it fell back to", async () => {
		const base = mkdtempSync(join(tmpdir(), "wasmedge-postinstall-"));
		tempDirs.push(base);
		const target = join(base, ".wasmedge-agent");
		vi.mocked(homedir).mockReturnValue(base);
		process.env[ENV_AGENT_DIR] = target;
		delete process.env.WASMEDGE_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL;
		delete process.env.WASMEDGE_AGENT_BOOTSTRAP_ON_INSTALL;
		process.env.PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL = "1";
		const written: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});

		try {
			await import("../src/postinstall.js");
		} finally {
			stderrSpy.mockRestore();
			delete process.env.PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL;
		}

		expect(written.join("")).toContain("PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL is deprecated");
		// The fallback was honoured, so the bootstrap really ran.
		expect(existsSync(join(target, "bin"))).toBe(true);
	});
});
