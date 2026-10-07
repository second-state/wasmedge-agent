import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { withBuildPermit } from "./build-gate.js";
import { type CargoSandbox, cargoCommand, cargoTargetDir } from "./cargo-sandbox.js";
import { type ProcOutcome, runProcess } from "./process.js";
import { type RuntimeResourceLimits, wasmedgeResourceArgs } from "./resource-limits.js";
import { skillTestFingerprint } from "./skill-fingerprint.js";
import { type LibFile, MAX_OUTPUT_CHARS, truncate } from "./types.js";
import { validateWasiImports } from "./wasm-imports.js";
import { applyLib, mountedSkillCrates } from "./workspace.js";
import { snapshotWorkspace } from "./workspace-snapshot.js";

export interface CrateTestOptions extends RuntimeResourceLimits {
	cargoSandbox?: CargoSandbox;
	workspaceDir: string;
	cargoBin: string;
	wasmedgeBin: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

function requireSuccess(result: ProcOutcome, phase: string): void {
	if (result.aborted) throw new Error(`${phase} aborted`);
	if (result.timedOut) throw new Error(`${phase} timed out`);
	if (result.exitCode !== 0) {
		throw new Error(`${phase} failed:\n${truncate(`${result.stdout}\n${result.stderr}`)}`);
	}
}

/** Compile test binaries only on the host; execute their WASI artifacts in
 * WasmEdge without the session's project, state, harness, or bridge mounts. */
export async function testRustCrate(crateName: string, options: CrateTestOptions, lib?: LibFile[]): Promise<void> {
	const resourceArgs = wasmedgeResourceArgs(options);
	const mounted = mountedSkillCrates(options.workspaceDir);
	const kind = lib ? "library" : "skill";
	const sourceLabel = lib ? "Library" : "Skill";
	options.signal?.throwIfAborted();
	const deadline = Date.now() + options.timeoutMs;
	const timeout = AbortSignal.timeout(Math.max(0, options.timeoutMs));
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const root = mkdtempSync(join(tmpdir(), `wasmedge-agent-${kind}-tests-`));
	try {
		const workspace = join(root, "workspace");
		const fingerprint = skillTestFingerprint(options.workspaceDir, mounted);
		snapshotWorkspace(options.workspaceDir, workspace, { mountedSkillsOnly: true });
		if (skillTestFingerprint(workspace, mounted) !== fingerprint) {
			throw new Error(`${sourceLabel} sources changed while taking the test snapshot; retry validation`);
		}
		if (lib) applyLib(workspace, lib);
		const testedFingerprint = lib ? skillTestFingerprint(workspace, mounted) : undefined;
		const target = cargoTargetDir(workspace, options.cargoSandbox);
		const build = await withBuildPermit(() => {
			const command = cargoCommand(
				options.cargoBin,
				[
					"test",
					"--release",
					"--offline",
					"--target",
					"wasm32-wasip1",
					"--no-run",
					"--lib",
					"--tests",
					"-p",
					crateName,
					"--message-format=json-diagnostic-rendered-ansi",
				],
				{
					cwd: workspace,
					cargoSandbox: options.cargoSandbox,
					processLimits: options.processLimits,
					processGroup: options.processGroup,
				},
			);
			return runProcess(command.bin, command.args, {
				cwd: workspace,
				timeoutMs: deadline - Date.now(),
				signal,
				env: {
					...command.env,
					CARGO_TARGET_DIR: target,
					CARGO_BUILD_TARGET_DIR: target,
					CARGO_BUILD_BUILD_DIR: target,
				},
			});
		}, signal);
		requireSuccess(build, `${kind} test build`);
		if (build.stdout.length >= MAX_OUTPUT_CHARS * 2) {
			throw new Error(`${kind} test build output exceeded the limit; cannot enumerate every test module`);
		}
		const artifacts = new Set<string>();
		for (const line of build.stdout.split("\n")) {
			if (!line.startsWith("{")) continue;
			const message = JSON.parse(line);
			if (message.reason !== "compiler-artifact" || !message.profile?.test || typeof message.executable !== "string")
				continue;
			const artifact = realpathSync(message.executable);
			const path = relative(realpathSync(target), artifact);
			if (!artifact.endsWith(".wasm") || path.startsWith("..") || isAbsolute(path)) {
				throw new Error(`${kind} test artifact is not a WASI module inside the test workspace`);
			}
			artifacts.add(artifact);
		}
		if (artifacts.size === 0) throw new Error(`${kind} test build produced no test modules`);
		// Inspect every artifact before any test can execute, including start
		// functions. Missing bridge credentials alone do not disable WASI sockets.
		for (const artifact of artifacts) {
			await validateWasiImports(await readFile(artifact, { signal }), `${kind} test`, signal);
		}
		const scratch = join(root, "scratch");
		mkdirSync(scratch);
		let passed = 0;
		for (const artifact of artifacts) {
			const result = await runProcess(
				options.wasmedgeBin,
				// Execute the inspected Wasm code, never embedded AOT native code.
				[
					"run",
					"--force-interpreter",
					...resourceArgs,
					"--dir",
					`/scratch:${scratch}`,
					artifact,
					"--test-threads=1",
					"--nocapture",
				],
				{
					cwd: workspace,
					timeoutMs: deadline - Date.now(),
					signal,
					processLimits: options.processLimits,
					processGroup: options.processGroup,
				},
			);
			requireSuccess(result, `sandboxed ${kind} tests`);
			const summary = /^test result: ok\. (\d+) passed; 0 failed;/m.exec(result.stdout);
			if (!summary) throw new Error(`${kind} tests require the standard Rust test harness`);
			passed += Number(summary[1]);
		}
		if (passed === 0) {
			const requirement = lib ? "library edits require" : "skill registration requires";
			throw new Error(`${requirement} at least one passing, non-ignored test`);
		}
		signal.throwIfAborted();
		if (testedFingerprint !== undefined && skillTestFingerprint(workspace, mounted) !== testedFingerprint) {
			throw new Error("Library test snapshot changed during testing; retry validation");
		}
		if (skillTestFingerprint(options.workspaceDir, mounted) !== fingerprint) {
			throw new Error(`${sourceLabel} sources changed during testing; retry validation`);
		}
	} catch (error) {
		options.signal?.throwIfAborted();
		if (timeout.aborted) throw new Error(`sandboxed ${kind} tests timed out`);
		throw error;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
