import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const installerSource = readFileSync(join(repoRoot, "install.sh"), "utf-8");

/** The installer's definitions, without the call that runs it. */
const harnessPrefix = installerSource.slice(0, installerSource.lastIndexOf('\nmain "$@"'));

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "installer-runtime-"));
	tempDirs.push(dir);
	return dir;
}

/** A curl that behaves as told: fails, or writes a script of `body`. */
function stubCurl(dir: string, body?: string): string {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	const curl = join(bin, "curl");
	writeFileSync(
		curl,
		body === undefined
			? `#!/bin/sh\nexit 22\n`
			: `#!/bin/sh
out=
while [ $# -gt 0 ]; do
	case "$1" in
		-o) out="$2"; shift 2 ;;
		*) shift ;;
	esac
done
cat > "$out" <<'SCRIPT'
${body}
SCRIPT
`,
	);
	chmodSync(curl, 0o755);
	return bin;
}

/** `process.env` with the installer's own knobs removed. The installer reads
 *  its whole `WASMEDGE_AGENT_*` namespace from the environment -- the WasmEdge
 *  override, the release channel, the version, the package -- so a caller that
 *  has one of them set would otherwise be deciding these tests. What a test
 *  needs from that namespace, the test sets itself. */
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("WASMEDGE_AGENT_")));

function run(dir: string, driver: string, extraPath?: string) {
	const harness = join(dir, "harness.sh");
	writeFileSync(harness, `${harnessPrefix}\n\n${driver}\n`);
	try {
		const stdout = execFileSync("sh", [harness], {
			env: {
				...hostEnv,
				...(extraPath ? { PATH: `${extraPath}:${process.env.PATH}` } : {}),
				WASMEDGE_AGENT_DOWNLOAD_BASE_URL: "https://releases.example.test",
			},
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, output: stdout };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
	}
}

describe("installer runtime provisioning", () => {
	it("fails when an installer script cannot be downloaded", () => {
		// The reason this is not just a curl check: `curl ... | sh` reports the
		// shell's status, and a shell handed nothing to run succeeds. A failed
		// download used to install nothing and say it had worked.
		const dir = workspace();

		const rustup = run(dir, "run_rustup_install", stubCurl(dir));
		const wasmedge = run(dir, "run_wasmedge_install", stubCurl(dir));

		expect(rustup.status).not.toBe(0);
		expect(rustup.output).toContain("could not download the rustup installer");
		expect(wasmedge.status).not.toBe(0);
		expect(wasmedge.output).toContain("could not download the WasmEdge installer");
	});

	it("fails when a downloaded installer script fails", () => {
		const dir = workspace();

		const result = run(dir, "run_rustup_install", stubCurl(dir, "exit 3"));

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("did not finish");
	});

	it("stops the install when a runtime component fails", () => {
		// This ran as `ensure_... || return 0`, which turned every failure into
		// success -- and, because the left side of || runs with errexit
		// suppressed, kept the commands inside from failing either.
		const dir = workspace();
		const log = join(dir, "log");

		const result = run(
			dir,
			`wasmedge_agent_bootstrap_runtime_on_install=1
ensure_rustup_and_target() { printf 'rustup\\n' >> "${log}"; return 1; }
ensure_wasmedge() { printf 'wasmedge\\n' >> "${log}"; return 0; }
prepare_rust_toolchain
printf 'continued\\n' >> "${log}"`,
		);

		expect(result.status).not.toBe(0);
		const steps = readFileSync(log, "utf-8");
		expect(steps).toContain("rustup");
		// Neither the next component nor anything after it: a runtime that was
		// attempted and did not install is not something to install on top of.
		expect(steps).not.toContain("wasmedge");
		expect(steps).not.toContain("continued");
	});

	it("continues when a component is deliberately skipped", () => {
		// Declining rustup is not a failed install: the skip path reports what
		// to run by hand, and the agent still installs.
		const dir = workspace();
		const log = join(dir, "log");

		const result = run(
			dir,
			`wasmedge_agent_bootstrap_runtime_on_install=1
ensure_rustup_and_target() { skip_cell_runtime_setup "install rustup yourself"; return 0; }
ensure_wasmedge() { printf 'wasmedge\\n' >> "${log}"; return 0; }
prepare_rust_toolchain
printf 'continued\\n' >> "${log}"`,
		);

		expect(result.status).toBe(0);
		expect(existsSync(log)).toBe(true);
		expect(readFileSync(log, "utf-8")).toContain("continued");
	});

	it("does nothing when the runtime bootstrap is off", () => {
		const dir = workspace();
		const log = join(dir, "log");

		const result = run(
			dir,
			`wasmedge_agent_bootstrap_runtime_on_install=0
ensure_rustup_and_target() { printf 'rustup\\n' >> "${log}"; return 1; }
ensure_wasmedge() { printf 'wasmedge\\n' >> "${log}"; return 1; }
prepare_rust_toolchain`,
		);

		expect(result.status).toBe(0);
		expect(existsSync(log)).toBe(false);
	});
});
