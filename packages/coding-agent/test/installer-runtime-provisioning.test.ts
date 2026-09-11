import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
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

/** A bin dir holding only what the code under test shells out to. --check
 *  otherwise finds the host's own node, npm and agent, and spends half a
 *  minute running a real `doctor --json` that proves nothing about it. */
function isolatedBin(dir: string): string {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	const grep = execFileSync("sh", ["-c", "command -v grep"], { encoding: "utf-8" }).trim();
	symlinkSync(grep, join(bin, "grep"));
	return bin;
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

	it("reports a WasmEdge that cannot run as broken rather than ok", () => {
		// Existence was the whole check, so a partial extraction, an interrupted
		// package install, or a build against another libc passed --check and
		// then failed at the first rust cell.
		const dir = workspace();
		const bin = isolatedBin(dir);
		writeFileSync(join(bin, "wasmedge"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(bin, "wasmedge"), 0o755);

		const result = run(dir, `PATH="${bin}"\nHOME="${dir}"\ncheck_wasmedge_agent_runtime`);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("broken   WasmEdge");
		expect(result.output).not.toContain("ok       WasmEdge");
	});

	it("reports the WasmEdge that WASMEDGE_AGENT_WASMEDGE names", () => {
		// --check reports on the runtime the agent will use, and the runtime
		// treats the override as its only candidate. This did not read it at
		// all, so --check could call a host missing while the agent ran fine.
		const dir = workspace();
		const bin = isolatedBin(dir);
		const override = join(dir, "custom-wasmedge");
		writeFileSync(override, '#!/bin/sh\necho "wasmedge version 0.14.1"\n');
		chmodSync(override, 0o755);

		const result = run(
			dir,
			`PATH="${bin}"\nHOME="${dir}"\nWASMEDGE_AGENT_WASMEDGE="${override}"\ncheck_wasmedge_agent_runtime`,
		);

		expect(result.output).toContain(`ok       WasmEdge (${override})`);
	});

	it("does not fall back from a broken WASMEDGE_AGENT_WASMEDGE", () => {
		// Pointing at a binary and silently getting a different one is worse
		// than being told this one does not work.
		const dir = workspace();
		const bin = isolatedBin(dir);
		writeFileSync(join(bin, "wasmedge"), '#!/bin/sh\necho "wasmedge version 0.14.1"\n');
		chmodSync(join(bin, "wasmedge"), 0o755);
		const override = join(dir, "custom-wasmedge");
		writeFileSync(override, "#!/bin/sh\nexit 1\n");
		chmodSync(override, 0o755);

		const result = run(
			dir,
			`PATH="${bin}"\nHOME="${dir}"\nWASMEDGE_AGENT_WASMEDGE="${override}"\ncheck_wasmedge_agent_runtime`,
		);

		expect(result.output).toContain("broken   WasmEdge");
		expect(result.output).not.toContain("ok       WasmEdge");
	});

	it("takes a working WasmEdge from behind a broken one on PATH", () => {
		// Selection stopped at the first candidate that existed, so a broken
		// PATH entry hid a working ~/.wasmedge/bin/wasmedge and no reinstall
		// could repair what was being selected.
		const dir = workspace();
		const bin = isolatedBin(dir);
		writeFileSync(join(bin, "wasmedge"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(bin, "wasmedge"), 0o755);
		const homeBin = join(dir, ".wasmedge", "bin");
		mkdirSync(homeBin, { recursive: true });
		writeFileSync(join(homeBin, "wasmedge"), '#!/bin/sh\necho "wasmedge version 0.14.1"\n');
		chmodSync(join(homeBin, "wasmedge"), 0o755);

		const result = run(dir, `PATH="${bin}"\nHOME="${dir}"\ncheck_wasmedge_agent_runtime`);

		expect(result.output).toContain(`ok       WasmEdge (${join(homeBin, "wasmedge")})`);
		expect(result.output).not.toContain("broken   WasmEdge");
	});

	it("provisions over a WasmEdge that cannot run", () => {
		// Provisioning returned early on the same existence check, so it left a
		// broken runtime where it found one and called the install done.
		const dir = workspace();
		const bin = join(dir, "bin");
		mkdirSync(bin, { recursive: true });
		const log = join(dir, "log");
		const driver = `HOME="${dir}"
wasmedge_agent_prompt_yes_no() { printf 'asked\\n' >> "${log}"; return 1; }
skip_cell_runtime_setup() { :; }
ensure_wasmedge`;

		writeFileSync(join(bin, "wasmedge"), '#!/bin/sh\necho "wasmedge version 0.14.1"\n');
		chmodSync(join(bin, "wasmedge"), 0o755);
		const working = run(dir, driver, bin);

		writeFileSync(join(bin, "wasmedge"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(bin, "wasmedge"), 0o755);
		const broken = run(dir, driver, bin);

		expect(working.status).toBe(0);
		expect(broken.status).toBe(0);
		// One asked, and it was not the one that already had a working runtime.
		expect(existsSync(log)).toBe(true);
		expect(readFileSync(log, "utf-8").trim()).toBe("asked");
	});

	/** A rustup whose default toolchain is nightly, and whose nightly has the
	 *  wasm target while stable has nothing. Logs every invocation. */
	function stubNightlyRustup(dir: string, log: string): string {
		const bin = isolatedBin(dir);
		writeFileSync(
			join(bin, "rustup"),
			`#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
	"toolchain list") printf 'nightly-x86_64-unknown-linux-gnu (default)\\n' ;;
	"target list --installed --toolchain stable") ;;
	"target list --installed") printf 'wasm32-wasip1\\n' ;;
esac
exit 0
`,
		);
		chmodSync(join(bin, "rustup"), 0o755);
		return bin;
	}

	it("reports the target against stable, not against a nightly default", () => {
		// `rustup target list --installed` reads the default toolchain, so this
		// asked nightly whether nightly had the target and reported the host
		// ready -- while issue #3 asks for the stable toolchain.
		const dir = workspace();
		const bin = stubNightlyRustup(dir, join(dir, "rustup-log"));

		const result = run(dir, `PATH="${bin}"\nHOME="${dir}"\ncheck_wasmedge_agent_runtime`);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("missing  the wasm32-wasip1 target on stable");
		expect(result.output).not.toContain("ok       rustup");
	});

	it("installs stable and adds the target to stable, leaving the default alone", () => {
		const dir = workspace();
		const log = join(dir, "rustup-log");
		const bin = stubNightlyRustup(dir, log);

		const driver = `PATH="${bin}"\nHOME="${dir}"\nwasmedge_agent_screen_enabled=0\nensure_rustup_and_target`;
		const result = run(dir, driver);

		expect(result.status).toBe(0);
		const calls = readFileSync(log, "utf-8").trim().split("\n");
		expect(calls).toEqual([
			"toolchain list",
			"toolchain install --no-self-update stable",
			"target list --installed --toolchain stable",
			"target add --toolchain stable wasm32-wasip1",
		]);
		// Nothing here selects a default toolchain: which one this host builds
		// with is its own choice, and issue #3 asks only that stable is there.
		expect(calls.some((call) => call.startsWith("default"))).toBe(false);
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

	it("removes the release manifest directory when the install fails", () => {
		// It is created before the version is resolved and used until the last
		// package is staged, so every failure in between used to leave it
		// behind: the EXIT trap knew only about the download directory.
		const dir = workspace();
		const root = join(dir, "temp-root");
		mkdirSync(root, { recursive: true });

		const result = run(
			dir,
			`TMPDIR="${root}"
wasmedge_agent_install_traps
wasmedge_agent_channel_dir=$(create_temp_dir)
exit 1`,
		);

		expect(result.status).not.toBe(0);
		expect(readdirSync(root)).toEqual([]);
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
	/** A yay/paru that exits `status`. With `installs`, it also drops a working
	 *  wasmedge on PATH, which is what a helper that did its job leaves behind. */
	function stubHelper(dir: string, name: string, status: number, installs = false): string {
		const bin = join(dir, "helper-bin");
		mkdirSync(bin, { recursive: true });
		const helper = join(bin, name);
		const install = installs
			? `printf '#!/bin/sh\\necho "wasmedge version 0.14.1"\\n' > "${join(bin, "wasmedge")}"\nchmod 755 "${join(bin, "wasmedge")}"\n`
			: "";
		writeFileSync(
			helper,
			`#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "${join(dir, "log")}"\n${install}exit ${status}\n`,
		);
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
			stubHelper(dir, "yay", 0, true),
		);

		expect(result.status).toBe(0);
		const steps = readFileSync(join(dir, "log"), "utf-8");
		expect(steps).toContain("yay -S --needed --noconfirm wasmedge-bin");
		expect(steps).not.toContain("official");
	});

	it("does not stop at a helper that reported success and installed nothing", () => {
		// Returning success here is what skips the official installer, and issue
		// #1 made that the fallback. A helper can exit zero and leave nothing
		// that runs, and doctor at the end of the install would then fail the
		// install rather than the fallback repairing it. So this drives
		// ensure_wasmedge and not the package function alone: the claim is that
		// the official installer runs after the package path gives up, and the
		// return value on its own does not say that anyone acted on it.
		const dir = workspace();
		const helperBin = stubHelper(dir, "yay", 0);

		const result = run(
			dir,
			`wasmedge_agent_screen_enabled=0
PATH="${helperBin}:${isolatedBin(dir)}"
HOME="${dir}"
wasmedge_agent_prompt_yes_no() { return 0; }
run_wasmedge_install() { printf 'official\\n' >> "${join(dir, "log")}"; }
ensure_wasmedge`,
		);

		expect(result.status).toBe(0);
		const steps = readFileSync(join(dir, "log"), "utf-8");
		expect(steps).toContain("yay -S --needed --noconfirm wasmedge-bin");
		expect(steps).toContain("official");
		expect(steps.indexOf("yay -S")).toBeLessThan(steps.indexOf("official"));
		expect(result.output).toContain("reported success and no WasmEdge runs");
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

	it.each([
		["stable", "latest.json", "latest/download/latest.json"],
		["beta", "beta.json", "download/beta/beta.json"],
	])("resolves the %s channel from %s", (channel, file, path) => {
		// One object decides what a channel means. It used to be published
		// twice -- as this JSON and as a one-line text file -- and read once
		// each way, so a publication that moved one and stopped left fresh
		// installs and installed agents on different releases.
		const dir = workspace();
		const served = join(dir, "served");
		mkdirSync(served, { recursive: true });
		writeFileSync(join(served, file), JSON.stringify({ version: "v4.5.6", package: "wasmedge-agent" }));
		const bin = join(dir, "bin");
		mkdirSync(bin, { recursive: true });
		const curl = join(bin, "curl");
		writeFileSync(
			curl,
			`#!/bin/sh
url=
out=
while [ $# -gt 0 ]; do
	case "$1" in
		-o) out="$2"; shift 2 ;;
		-*) shift ;;
		*) url="$1"; shift ;;
	esac
done
printf '%s\\n' "$url" >> "${join(dir, "requested")}"
name=\${url##*/}
[ -f "${served}/$name" ] || exit 22
cp "${served}/$name" "$out"
`,
		);
		chmodSync(curl, 0o755);

		const result = run(
			dir,
			`wasmedge_agent_run_quiet_with_animation() { shift 3; "$@"; }
wasmedge_agent_channel_manifest="${join(dir, "channel.json")}"
printf '%s\\n' "$(resolve_wasmedge_agent_version ${channel})"`,
			bin,
		);

		expect(result.status).toBe(0);
		expect(result.output.trim()).toBe("4.5.6");
		expect(readFileSync(join(dir, "requested"), "utf-8").trim()).toBe(`https://releases.example.test/${path}`);
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
