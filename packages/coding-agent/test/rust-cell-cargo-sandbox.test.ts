import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CargoSandbox,
	cargoArtifactPath,
	cargoCommand,
	cargoTargetDir,
	normalizeCargoSandbox,
} from "../src/core/rust-cell/cargo-sandbox.js";
import { ProcessResourceGroup, RustCellProvisioner } from "../src/core/rust-cell/index.js";
import { runProcess } from "../src/core/rust-cell/process.js";
import { RUSTDOC_TEST_TOOLCHAIN } from "../src/core/rust-cell/rustdoc-index.js";
import { findCargoBin, resolveToolchain } from "../src/core/rust-cell/toolchain.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createRustToolDefinition } from "../src/core/tools/rust.js";
import { hasProcessLimits } from "./fixtures/process-limits.js";
import { hasRustdocToolchain } from "./fixtures/rustdoc.js";

const roots: string[] = [];
const runtimes: RustCellProvisioner[] = [];
const groups: ProcessResourceGroup[] = [];
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
	for (const group of groups.splice(0)) group.dispose();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function rootDir() {
	const root = mkdtempSync(join(tmpdir(), "cargo-sandbox-test-"));
	roots.push(root);
	return root;
}

describe("Cargo sandbox configuration", () => {
	it("defaults off, rejects unknown modes, and fails closed on unsupported platforms", () => {
		expect(SettingsManager.inMemory({}).getRustCellCargoSandbox()).toBe("off");
		expect(normalizeCargoSandbox("bubblewrap", "linux")).toBe("bubblewrap");
		for (const platform of ["darwin", "win32"] as const)
			expect(() => normalizeCargoSandbox("bubblewrap", platform)).toThrow("requires Linux");
		for (const invalid of [null, true, 1, {}, "auto"]) {
			const cargoSandbox = invalid as CargoSandbox;
			expect(() => SettingsManager.inMemory({ rustCell: { cargoSandbox } }).getRustCellCargoSandbox()).toThrow(
				"cargoSandbox",
			);
			expect(() => new RustCellProvisioner({ cwd: "/unused", cargoSandbox })).toThrow("cargoSandbox");
			expect(() => createRustToolDefinition("/unused", { cargoSandbox })).toThrow("cargoSandbox");
		}
	});
	it("rejects compiler artifact links outside the isolated cache", () => {
		const workspace = rootDir();
		const target = cargoTargetDir(workspace, "bubblewrap");
		mkdirSync(target, { recursive: true });
		const outside = join(workspace, "private-artifact");
		writeFileSync(outside, "private");
		const artifact = join(target, "artifact");
		symlinkSync(outside, artifact);
		expect(() => cargoArtifactPath(workspace, "bubblewrap", artifact)).toThrow("escapes");
		rmSync(artifact);
		writeFileSync(artifact, "owned");
		expect(readFileSync(cargoArtifactPath(workspace, "bubblewrap", artifact), "utf8")).toBe("owned");
	});
	it("leaves the disabled command unchanged and does not inherit credentials", () => {
		vi.stubEnv("CARGO_SANDBOX_TEST_SECRET", "not-a-real-secret");
		const command = cargoCommand("cargo", ["build", "--release"], { cwd: "/unused" });
		expect(command.bin).toBe("cargo");
		expect(command.args).toEqual(["build", "--release"]);
		expect(command.env.CARGO_SANDBOX_TEST_SECRET).toBeUndefined();
	});
});

const available = process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync(findCargoBin());
if (process.platform === "linux" && process.env.CI && process.env.WASMEDGE_AGENT_WASMEDGE) {
	it("has the required Linux sandbox tools in CI", () => expect(available).toBe(true));
}

describe.skipIf(!available)("Bubblewrap with real Cargo", () => {
	function fixture() {
		const root = rootDir();
		const workspace = join(root, "workspace");
		mkdirSync(join(workspace, "src"), { recursive: true });
		writeFileSync(
			join(workspace, "Cargo.toml"),
			'[package]\nname="sandbox_fixture"\nversion="0.1.0"\nedition="2021"\n[workspace]\n[profile.dev.package."*"]\ndebug=false\n',
		);
		writeFileSync(join(workspace, "src/main.rs"), "fn main() {}\n");
		const secret = join(root, "host-secret");
		writeFileSync(secret, "test-only-file-secret");
		const run = async (args = ["build", "--release"], signal?: AbortSignal) => {
			const command = cargoCommand(findCargoBin(), args, { cwd: workspace, cargoSandbox: "bubblewrap" });
			return runProcess(command.bin, command.args, { cwd: workspace, env: command.env, timeoutMs: 60_000, signal });
		};
		return { root, workspace, secret, run };
	}

	it("rejects include_str outside the workspace even with a matching unsandboxed artifact", async () => {
		const { workspace, secret, run } = fixture();
		writeFileSync(
			join(workspace, "src/main.rs"),
			`fn main() { println!("{}", include_str!(${JSON.stringify(secret)})); }`,
		);
		execFileSync(findCargoBin(), ["build", "--release"], { cwd: workspace, stdio: "pipe" });
		const denied = await run();
		expect(denied.exitCode, denied.stderr).not.toBe(0);
		expect(denied.stderr).toContain("host-secret");
		expect(denied.stderr).not.toContain("test-only-file-secret");
		writeFileSync(join(workspace, "src/main.rs"), "fn main() {}\n");
		const allowed = await run();
		expect(allowed.exitCode, allowed.stderr).toBe(0);
		expect(existsSync(join(cargoTargetDir(workspace, "bubblewrap"), "release/sandbox_fixture"))).toBe(true);
	}, 90_000);

	it("restricts build scripts and proc macros while supporting read-only linked skills and lock updates", async () => {
		const { root, workspace, secret, run } = fixture();
		const server = createServer((socket) => socket.destroy());
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("No test server address");
			for (const dir of ["state", ".git", "target"]) {
				mkdirSync(join(workspace, dir), { recursive: true });
				writeFileSync(join(workspace, dir, "hidden"), "private");
			}
			vi.stubEnv("CARGO_SANDBOX_TEST_SECRET", "not-a-real-secret");
			const cargoHome = join(root, "cargo-home");
			mkdirSync(cargoHome);
			writeFileSync(join(cargoHome, "config.toml"), '[env]\nCARGO_CONFIG_TEST_SECRET="test-only-secret"\n');
			writeFileSync(join(cargoHome, "credentials.toml"), "test-only-registry-secret");
			vi.stubEnv("CARGO_HOME", cargoHome);
			const checks = `
assert!(std::env::var("CARGO_SANDBOX_TEST_SECRET").is_err());
assert!(std::env::var("CARGO_CONFIG_TEST_SECRET").is_err());
assert!(std::fs::read("/tmp/cargo-home/credentials.toml").is_err());
assert!(std::fs::read(${JSON.stringify(secret)}).is_err());
${["state/hidden", ".git/hidden", "target/hidden"].map((path) => `assert!(std::fs::read(${JSON.stringify(join(workspace, path))}).is_err());`).join("\n")}
assert!(std::fs::write(${JSON.stringify(join(workspace, "src/escape.rs"))}, "bad").is_err());
assert!(std::os::unix::fs::symlink(${JSON.stringify(secret)}, ${JSON.stringify(join(workspace, "src/link"))}).is_err());
assert!(std::net::TcpStream::connect_timeout(&"127.0.0.1:${address.port}".parse().unwrap(), std::time::Duration::from_millis(200)).is_err());
`;
			writeFileSync(join(workspace, "build.rs"), `fn main() { ${checks} }`);
			mkdirSync(join(workspace, "guard/src"), { recursive: true });
			writeFileSync(
				join(workspace, "guard/Cargo.toml"),
				'[package]\nname="guard"\nversion="0.1.0"\nedition="2021"\n[lib]\nproc-macro=true\n',
			);
			writeFileSync(
				join(workspace, "guard/src/lib.rs"),
				`#[proc_macro] pub fn checked(_: proc_macro::TokenStream) -> proc_macro::TokenStream { ${checks} "fn main() { assert_eq!(external::value(), 7); }".parse().unwrap() }`,
			);
			const skill = join(root, "skill");
			mkdirSync(join(skill, "src"), { recursive: true });
			writeFileSync(join(skill, "Cargo.toml"), '[package]\nname="external"\nversion="0.1.0"\nedition="2021"\n');
			writeFileSync(join(skill, "src/lib.rs"), "pub fn value() -> u8 { 7 }");
			mkdirSync(join(workspace, "skills"));
			symlinkSync(skill, join(workspace, "skills/external"));
			writeFileSync(
				join(workspace, "Cargo.toml"),
				`${readFileSync(join(workspace, "Cargo.toml"), "utf8")}\n[dependencies]\nguard={path="guard"}\nexternal={path="skills/external"}\n`,
			);
			writeFileSync(join(workspace, "src/main.rs"), "guard::checked!();");
			const result = await run();
			expect(result.exitCode, result.stderr).toBe(0);
			expect(readFileSync(join(workspace, "Cargo.lock"), "utf8")).toContain('name = "external"');
			expect(existsSync(join(workspace, "src/escape.rs"))).toBe(false);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 90_000);

	it("hides Cargo credentials even when its home overlaps a toolchain mount", async () => {
		const { root, workspace } = fixture();
		const cargoHome = join(root, "combined-tools");
		mkdirSync(cargoHome);
		const credentials = join(cargoHome, "credentials.toml");
		writeFileSync(credentials, "test-only-credential");
		vi.stubEnv("CARGO_HOME", cargoHome);
		vi.stubEnv("RUSTUP_HOME", cargoHome);
		const command = cargoCommand(
			"/usr/bin/sh",
			["-c", 'cat "$1" 2>/dev/null; printf policy-ran', "sh", credentials],
			{ cwd: workspace, cargoSandbox: "bubblewrap" },
		);
		const result = await runProcess(command.bin, command.args, {
			cwd: workspace,
			env: command.env,
			timeoutMs: 10_000,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toBe("policy-ran");
		expect(readFileSync(credentials, "utf8")).toBe("test-only-credential");
	});

	it("kills detached build descendants on cancellation", async () => {
		const { workspace } = fixture();
		const marker = join(cargoTargetDir(workspace, "bubblewrap"), "survived");
		writeFileSync(
			join(workspace, "build.rs"),
			`fn main() { std::process::Command::new("setsid").args(["sh", "-c", ${JSON.stringify(`sleep 1; echo escaped > ${marker}`)}]).spawn().unwrap(); eprintln!("sandbox-child-ready"); std::thread::sleep(std::time::Duration::from_secs(60)); }`,
		);
		const controller = new AbortController();
		const command = cargoCommand(findCargoBin(), ["build", "--release", "-vv"], {
			cwd: workspace,
			cargoSandbox: "bubblewrap",
		});
		const result = await runProcess(command.bin, command.args, {
			cwd: workspace,
			env: command.env,
			timeoutMs: 60_000,
			signal: controller.signal,
			onChunk: (text) => {
				if (text.includes("sandbox-child-ready")) controller.abort();
			},
		});
		expect(result.aborted, result.stderr).toBe(true);
		await delay(1500);
		expect(existsSync(marker)).toBe(false);
	}, 90_000);

	it.skipIf(!hasProcessLimits())(
		"bounds build-script memory and permits a retry without limits",
		async () => {
			const { workspace, run } = fixture();
			writeFileSync(
				join(workspace, "build.rs"),
				'fn main() { eprintln!("allocation-started"); let data = vec![42u8; 384 * 1024 * 1024]; std::hint::black_box(data); }',
			);
			const command = cargoCommand(findCargoBin(), ["build", "--release", "-vv"], {
				cwd: workspace,
				cargoSandbox: "bubblewrap",
				processLimits: { memoryMaxMb: 256 },
			});
			const denied = await runProcess(command.bin, command.args, {
				cwd: workspace,
				env: command.env,
				timeoutMs: 60_000,
			});
			expect(denied.exitCode).not.toBe(0);
			expect(denied.timedOut).toBe(false);
			expect(denied.stderr).toContain("allocation-started");
			const allowed = await run();
			expect(allowed.exitCode, allowed.stderr).toBe(0);
		},
		90_000,
	);

	it("rejects symlink caches and lock files before launching Cargo", () => {
		const { root, workspace, secret } = fixture();
		symlinkSync(secret, join(workspace, "Cargo.lock"));
		expect(() => cargoCommand(findCargoBin(), [], { cwd: workspace, cargoSandbox: "bubblewrap" })).toThrow(
			"Cargo.lock",
		);
		rmSync(join(workspace, "Cargo.lock"));
		rmSync(join(workspace, "target"), { recursive: true });
		symlinkSync(root, join(workspace, "target"));
		expect(() => cargoCommand(findCargoBin(), [], { cwd: workspace, cargoSandbox: "bubblewrap" })).toThrow(
			"target directories",
		);
	});
});

let runtimeAvailable = false;
if (available) {
	try {
		resolveToolchain();
		runtimeAvailable = hasRustdocToolchain();
	} catch {}
}
if (process.platform === "linux" && process.env.CI && process.env.WASMEDGE_AGENT_WASMEDGE) {
	it("has the required runtime and rustdoc toolchains in CI", () => expect(runtimeAvailable).toBe(true));
}

describe.skipIf(!runtimeAvailable || !hasProcessLimits())("Cargo sandbox with process limits runtime wiring", () => {
	it("covers provisioning, library tests, dependency updates, rustdoc, and resumed execution", async () => {
		const root = rootDir();
		const skill = join(root, "guarded-skill");
		mkdirSync(join(skill, "src"), { recursive: true });
		writeFileSync(join(skill, "Cargo.toml"), '[package]\nname="guarded_skill"\nversion="0.1.0"\nedition="2021"\n');
		writeFileSync(
			join(skill, "src/lib.rs"),
			"pub fn value() -> u8 { 7 } #[test] fn correct() { assert_eq!(value(), 7); }",
		);
		const group = new ProcessResourceGroup({ memoryMaxMb: 3072, cpuQuotaPercent: 300, tasksMax: 384 });
		groups.push(group);
		const options = {
			cwd: root,
			processGroup: group,
			rustSkills: [
				{ name: "guarded", crateName: "guarded_skill", cratePath: skill, cargoTomlPath: join(skill, "Cargo.toml") },
			],
			workspaceDir: join(root, "workspace"),
			cargoSandbox: "bubblewrap" as const,
			processLimits: { memoryMaxMb: 2048, cpuQuotaPercent: 200, tasksMax: 256 },
			libraryTestGate: true,
			rustdocToolchain: RUSTDOC_TEST_TOOLCHAIN,
			cellTimeoutMs: 180_000,
		};
		const runtime = new RustCellProvisioner(options);
		runtimes.push(runtime);
		const runner = await runtime.ensure();
		await runtime.testSkill({ type: "rust", use: "agent_lib::skills::guarded_skill" });
		const first = await runner.execute({
			lib: [
				{
					path: "src/helpers/guarded.rs",
					content: "pub fn value() -> u8 { 7 } #[test] fn correct() { assert_eq!(value(), 7); }",
				},
			],
			code: 'fn main() { assert_eq!(agent_lib::helpers::guarded::value(), 7); println!("sandbox cell"); }',
		});
		expect(first.status, first.compileDiagnostics ?? first.stderr).toBe("ok");
		const secret = join(root, "compile-secret");
		writeFileSync(secret, "test-only-secret");
		const saved = readFileSync(join(options.workspaceDir, "cell/src/main.rs"), "utf8");
		const denied = await runner.execute({
			code: `fn main() { println!("{}", include_str!(${JSON.stringify(secret)})); }`,
		});
		expect(denied.status, denied.stderr).toBe("compile_error");
		expect(readFileSync(join(options.workspaceDir, "cell/src/main.rs"), "utf8")).toBe(saved);
		const deps = await runner.execute({
			code: 'use agent_lib::prelude::rlm; fn main() -> Result<(), Box<dyn std::error::Error>> { rlm::deps::add("itoa")?; Ok(()) }',
		});
		expect(deps.status, deps.compileDiagnostics ?? deps.stderr).toBe("ok");
		const api = await runner.execute({
			code: 'use agent_lib::prelude::rlm; fn main() -> Result<(), Box<dyn std::error::Error>> { println!("{:?}", rlm::api::describe("agent_lib::helpers::guarded::value")?); Ok(()) }',
		});
		expect(api.status, api.compileDiagnostics ?? api.stderr).toBe("ok");
		expect(api.stdout).toContain("guarded::value");
		await runtime.dispose();
		const resumed = new RustCellProvisioner(options);
		runtimes.push(resumed);
		const result = await (await resumed.ensure()).execute({
			code: 'fn main() { let mut b = agent_lib::prelude::extra::itoa::Buffer::new(); assert_eq!(b.format(7), "7"); }',
		});
		expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
	}, 300_000);
});
