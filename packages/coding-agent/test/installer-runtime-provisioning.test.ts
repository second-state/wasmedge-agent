import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
		// Both streams, in both outcomes: some of what this checks is a warning
		// on stderr from a run that succeeds.
		const stdout = execFileSync("sh", ["-c", `sh "${harness}" 2>&1`], {
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

describe("installer arguments and runtime provisioning", () => {
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

	it.each([["--yes"], ["--now"], ["-y"]])("%s selects an unattended install", (option) => {
		// Issue #5 defines --now as running the non-interactive installer
		// immediately, which is this mode. Giving it another meaning here
		// would make one name mean two things across the two entry points.
		const dir = workspace();

		const result = run(
			dir,
			`parse_wasmedge_agent_arguments "${option}"\nprintf '%s\\n' "$wasmedge_agent_assume_yes"`,
		);

		expect(result.status).toBe(0);
		expect(result.output.trim()).toBe("1");
	});

	it("answers prompts without a terminal under --yes", () => {
		// The prompt reports "no terminal" rather than an answer, and every
		// prompt here defaults to install, so unattended means answering them
		// rather than skipping the work behind them.
		const dir = workspace();

		const result = run(
			dir,
			`parse_wasmedge_agent_arguments --yes
if wasmedge_agent_prompt_yes_no "q" "d" "p"; then printf 'yes\\n'; else printf 'status %s\\n' "$?"; fi`,
		);

		expect(result.status).toBe(0);
		expect(result.output).toContain("yes");
	});

	it("--check selects the report-only mode", () => {
		const dir = workspace();

		const result = run(dir, `parse_wasmedge_agent_arguments --check\nprintf '%s\\n' "$wasmedge_agent_check_only"`);

		expect(result.status).toBe(0);
		expect(result.output.trim()).toBe("1");
	});

	it("takes a channel or version as its one positional argument", () => {
		const dir = workspace();

		const result = run(
			dir,
			`parse_wasmedge_agent_arguments --yes beta\nprintf '%s\\n' "$wasmedge_agent_requested_version"`,
		);

		expect(result.status).toBe(0);
		expect(result.output.trim()).toBe("beta");
	});

	it("refuses an option it does not implement", () => {
		// The version validator accepts hyphens, so an unknown option used to
		// resolve as a release version and be fetched as one.
		const dir = workspace();

		const result = run(dir, "parse_wasmedge_agent_arguments --wat");

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("unknown option: --wat");
	});

	it("refuses a second version argument", () => {
		const dir = workspace();

		const result = run(dir, "parse_wasmedge_agent_arguments beta 1.2.3");

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("unexpected argument: 1.2.3");
	});

	it("reports a missing runtime under --check without changing anything", () => {
		// Read-only is the point: a launcher can run this on every invocation.
		const dir = workspace();
		const empty = join(dir, "empty-bin");
		mkdirSync(empty, { recursive: true });

		const result = run(dir, `PATH="${empty}"\ncheck_wasmedge_agent_runtime`);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("missing  Node.js");
		expect(result.output).toContain("missing  WasmEdge");
		expect(result.output).toContain("missing  wasmedge-agent");
	});

	it("fails the install when npm produced no usable command", () => {
		// npm reported success and there is no command: the install did not
		// produce the thing it exists for, and saying otherwise also skipped
		// the --version and doctor workflows issue #3 requires.
		const dir = workspace();
		const empty = join(dir, "empty-bin");
		mkdirSync(empty, { recursive: true });

		const result = run(dir, `wasmedge_agent_screen_enabled=0\nPATH="${empty}"\nrun_wasmedge_agent_doctor`);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("no wasmedge-agent command was found");
	});

	it("installs Node.js without a terminal rather than printing instructions", () => {
		// `curl ... | sh` on a clean host is the case this installer exists
		// for, and the two runtime prompts have always read "no terminal" as
		// consent to proceed.
		const dir = workspace();
		const log = join(dir, "log");

		const result = run(
			dir,
			`detect_node_install_method() { printf 'standalone\\n'; }
install_node_npm() { printf 'installed %s\\n' "$1" >> "${log}"; }
install_node_npm_interactive
printf 'status %s\\n' "$?" >> "${log}"`,
		);

		expect(result.status).toBe(0);
		const steps = readFileSync(log, "utf-8");
		expect(steps).toContain("installed standalone");
		expect(steps).toContain("status 0");
	});

	/** The installed command, reporting a runtime that is healthy or is not.
	 *
	 *  A JSON document, because that is what the installer reads: `doctor
	 *  --fix` exits 0 either way, since it also reaps background services and
	 *  runs on hosts that will never have a Rust toolchain. */
	function stubAgent(dir: string, healthy: boolean): string {
		const bin = join(dir, "agent-bin");
		mkdirSync(bin, { recursive: true });
		const agent = join(bin, "wasmedge-agent");
		const report = JSON.stringify({
			runtime: [{ name: "wasmedge", ok: healthy, detail: healthy ? "0.14.1" : "not found" }],
			fixes: [],
			reaped: [],
			skipped: [],
		});
		writeFileSync(agent, `#!/bin/sh\nprintf 'doctor %s\\n' "$*" >> "${join(dir, "log")}"\nprintf '%s' '${report}'\n`);
		chmodSync(agent, 0o755);
		return bin;
	}

	it("runs doctor --fix through the installed command", () => {
		// Issue #3's final step, and the only one that exercises the command
		// the install just produced.
		const dir = workspace();

		const result = run(dir, "wasmedge_agent_screen_enabled=0\nrun_wasmedge_agent_doctor", stubAgent(dir, true));

		expect(result.status).toBe(0);
		expect(readFileSync(join(dir, "log"), "utf-8")).toContain("doctor doctor --fix --json");
	});

	it("fails the install when doctor reports a runtime it could not repair", () => {
		// Read out of the report rather than from the status: `doctor --fix`
		// exits 0 whether or not the runtime is healthy, and taking that for
		// an answer is what let an install report success over a runtime the
		// agent had just described as broken.
		const dir = workspace();

		const result = run(
			dir,
			`wasmedge_agent_screen_enabled=0
wasmedge_agent_bootstrap_runtime_on_install=1
run_wasmedge_agent_doctor`,
			stubAgent(dir, false),
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("could not repair");
		expect(result.output).toContain("wasmedge: not found");
	});

	it("reads the doctor report with the animated screen on", () => {
		// The normal interactive path, and the one every other test here
		// stepped around by turning the screen off. The animated helper writes
		// the command's output to a file it shows only on failure and then
		// deletes, so read through it the report came back empty and a healthy
		// install failed on JSON it could not parse.
		const dir = workspace();

		const result = run(
			dir,
			`wasmedge_agent_screen_enabled=1
wasmedge_agent_bootstrap_runtime_on_install=1
run_wasmedge_agent_doctor`,
			stubAgent(dir, true),
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(dir, "log"), "utf-8")).toContain("doctor doctor --fix --json");
	});

	it("fails an animated install when the report says the runtime is broken", () => {
		// The other half: the report is not merely reaching the parser, it is
		// still the thing the install is decided on.
		const dir = workspace();

		const result = run(
			dir,
			`wasmedge_agent_screen_enabled=1
wasmedge_agent_bootstrap_runtime_on_install=1
run_wasmedge_agent_doctor`,
			stubAgent(dir, false),
		);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("could not repair");
	});

	it("warns rather than failing when the runtime setup was skipped", () => {
		// A deliberate partial install: skip_cell_runtime_setup has already
		// said what to run by hand, so doctor reporting it is not news the
		// install should fail on.
		const dir = workspace();

		const result = run(
			dir,
			`wasmedge_agent_screen_enabled=0
wasmedge_agent_bootstrap_runtime_on_install=0
run_wasmedge_agent_doctor`,
			stubAgent(dir, false),
		);

		expect(result.status).toBe(0);
		expect(result.output).toContain("runtime setup above was skipped");
	});

	/** Runs a driver with the screen on, waits for `ready`, and interrupts it.
	 *
	 *  Returns once the installer has exited, so the assertions afterwards see
	 *  whatever its traps left behind. */
	async function interrupt(dir: string, driver: string, ready: () => boolean): Promise<void> {
		const harness = join(dir, "interrupt.sh");
		writeFileSync(harness, `${harnessPrefix}\n\n${driver}\n`);

		const child = spawn("sh", [harness], { env: hostEnv, stdio: ["ignore", "ignore", "ignore"] });
		const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

		const started = Date.now();
		while (Date.now() - started < 10_000) {
			if (ready()) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		child.kill("SIGINT");
		await exited;
	}

	it("stops the animated command and removes its directory when interrupted", async () => {
		// Ctrl-C during a download leaves the helper's own cleanup unreached:
		// the temporary directory stays, and what it was running is still
		// running.
		const dir = workspace();
		const root = join(dir, "temp-root");
		mkdirSync(root, { recursive: true });
		const pidFile = join(dir, "child.pid");
		const reportFile = join(dir, "report.json");

		await interrupt(
			dir,
			`TMPDIR="${root}"
wasmedge_agent_screen_enabled=1
wasmedge_agent_install_traps
wasmedge_agent_run_capture_with_animation "${reportFile}" "Checking" "Checking" "detail" \\
\tsh -c 'printf "%s" "$$" > "${pidFile}"; exec sleep 30'`,
			() => existsSync(pidFile) && readdirSync(root).length > 0,
		);

		const child = Number(readFileSync(pidFile, "utf-8"));
		expect(child).toBeGreaterThan(0);
		expect(readdirSync(root)).toEqual([]);
		expect(() => process.kill(child, 0)).toThrow();
	});

	it("stops an interrupted doctor run and removes what it left", async () => {
		// The production path, which the test above does not exercise: doctor
		// used to be read through a command substitution, and a substitution
		// runs in a subshell -- so the helper recorded the child and the
		// directory in variables the parent's traps could not see, and an
		// interrupt left doctor running with its directory behind.
		const dir = workspace();
		const root = join(dir, "temp-root");
		mkdirSync(root, { recursive: true });
		const pidFile = join(dir, "doctor.pid");
		const bin = join(dir, "agent-bin");
		mkdirSync(bin, { recursive: true });
		const agent = join(bin, "wasmedge-agent");
		writeFileSync(agent, `#!/bin/sh\nprintf '%s' "$$" > "${pidFile}"\nexec sleep 30\n`);
		chmodSync(agent, 0o755);

		await interrupt(
			dir,
			`TMPDIR="${root}"
PATH="${bin}:$PATH"
wasmedge_agent_screen_enabled=1
wasmedge_agent_install_traps
run_wasmedge_agent_doctor`,
			() => existsSync(pidFile) && readdirSync(root).length > 0,
		);

		const doctor = Number(readFileSync(pidFile, "utf-8"));
		expect(doctor).toBeGreaterThan(0);
		expect(readdirSync(root)).toEqual([]);
		expect(() => process.kill(doctor, 0)).toThrow();
	});

	it("stops what the animated command itself started", async () => {
		// Killing the process this shell started leaves what that process
		// started running: the animated commands are package managers and npm
		// installs, so the descendant is the thing actually doing the work.
		const dir = workspace();
		const root = join(dir, "temp-root");
		mkdirSync(root, { recursive: true });
		const pidFile = join(dir, "grandchild.pid");

		await interrupt(
			dir,
			`TMPDIR="${root}"
wasmedge_agent_screen_enabled=1
wasmedge_agent_install_traps
wasmedge_agent_run_quiet_with_animation "Installing" "Installing" "detail" \\
\tsh -c 'sleep 30 & printf "%s" "$!" > "${pidFile}"; wait'`,
			() => existsSync(pidFile) && readdirSync(root).length > 0,
		);

		const grandchild = Number(readFileSync(pidFile, "utf-8"));
		expect(grandchild).toBeGreaterThan(0);
		expect(readdirSync(root)).toEqual([]);
		expect(() => process.kill(grandchild, 0)).toThrow();
	});

	/** An AUR helper on PATH, answering with `status`. */
	function stubHelper(dir: string, name: string, status: number): string {
		const bin = join(dir, "helper-bin");
		mkdirSync(bin, { recursive: true });
		const helper = join(bin, name);
		writeFileSync(helper, `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "${join(dir, "log")}"\nexit ${status}\n`);
		chmodSync(helper, 0o755);
		return bin;
	}

	it("installs the wasmedge-bin package when a helper is available", () => {
		// Issue #1 fixed the order: the package first, the official installer
		// as the fallback. It lives in the AUR, so it takes a helper.
		const dir = workspace();

		const result = run(
			dir,
			`wasmedge_agent_screen_enabled=0
run_wasmedge_install() { printf 'official\\n' >> "${join(dir, "log")}"; }
install_wasmedge_bin_package`,
			stubHelper(dir, "yay", 0),
		);

		expect(result.status).toBe(0);
		const steps = readFileSync(join(dir, "log"), "utf-8");
		expect(steps).toContain("yay -S --needed --noconfirm wasmedge-bin");
		expect(steps).not.toContain("official");
	});

	it("falls back to the official installer when the helper fails", () => {
		const dir = workspace();

		const result = run(
			dir,
			`wasmedge_agent_screen_enabled=0
if install_wasmedge_bin_package; then printf 'package\\n' >> "${join(dir, "log")}"; else printf 'fallback\\n' >> "${join(dir, "log")}"; fi`,
			stubHelper(dir, "yay", 1),
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(dir, "log"), "utf-8")).toContain("fallback");
		expect(result.output).toContain("could not install wasmedge-bin");
	});

	it("reports no package path on a host with no helper", () => {
		// Every host that is not Arch. The official installer is what runs
		// there, which is what has always run.
		const dir = workspace();
		const empty = join(dir, "empty-bin");
		mkdirSync(empty, { recursive: true });

		const result = run(
			dir,
			`wasmedge_agent_screen_enabled=0
PATH="${empty}"
if install_wasmedge_bin_package; then printf 'package\\n' >> "${join(dir, "log")}"; else printf 'fallback\\n' >> "${join(dir, "log")}"; fi`,
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(dir, "log"), "utf-8")).toContain("fallback");
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
