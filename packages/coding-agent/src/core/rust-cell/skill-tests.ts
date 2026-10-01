import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { withBuildPermit } from "./build-gate.js";
import { type ProcOutcome, runProcess } from "./process.js";
import { type CellResourceLimits, wasmedgeResourceArgs } from "./resource-limits.js";
import { MAX_OUTPUT_CHARS, truncate } from "./types.js";
import { validateWasiImports } from "./wasm-imports.js";
import { syncRustSkills } from "./workspace.js";
import { snapshotWorkspace, withInheritedSkills } from "./workspace-snapshot.js";

interface SkillTestOptions extends CellResourceLimits {
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
export async function testRustSkill(reference: Record<string, unknown>, options: SkillTestOptions): Promise<void> {
	const resourceArgs = wasmedgeResourceArgs(options);
	const match =
		typeof reference.use === "string"
			? /^agent_lib::skills::([a-zA-Z_][a-zA-Z0-9_]*)(?:::[a-zA-Z_][a-zA-Z0-9_]*)*$/.exec(reference.use)
			: null;
	if (reference.type !== "rust" || !match)
		throw new Error("skill tests require an agent_lib::skills::<crate> reference");
	const crateName = match[1];
	if (!existsSync(join(options.workspaceDir, "skills", crateName, "Cargo.toml"))) {
		throw new Error(`skill crate ${crateName} is not mounted; reload skills before refinement`);
	}
	options.signal?.throwIfAborted();
	const deadline = Date.now() + options.timeoutMs;
	const timeout = AbortSignal.timeout(Math.max(0, options.timeoutMs));
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const root = mkdtempSync(join(tmpdir(), "wasmedge-agent-skill-tests-"));
	try {
		const workspace = join(root, "workspace");
		snapshotWorkspace(options.workspaceDir, workspace);
		syncRustSkills(workspace, withInheritedSkills(workspace, []));
		const target = join(workspace, "target");
		const build = await withBuildPermit(
			() =>
				runProcess(
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
						timeoutMs: deadline - Date.now(),
						signal,
						env: {
							...process.env,
							CARGO_TARGET_DIR: target,
							CARGO_BUILD_TARGET_DIR: target,
							CARGO_BUILD_BUILD_DIR: target,
						},
					},
				),
			signal,
		);
		requireSuccess(build, "skill test build");
		if (build.stdout.length >= MAX_OUTPUT_CHARS * 2) {
			throw new Error("skill test build output exceeded the limit; cannot enumerate every test module");
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
				throw new Error("skill test artifact is not a WASI module inside the test workspace");
			}
			artifacts.add(artifact);
		}
		if (artifacts.size === 0) throw new Error("skill test build produced no test modules");
		// Inspect every artifact before any test can execute, including start
		// functions. Missing bridge credentials alone do not disable WASI sockets.
		for (const artifact of artifacts) {
			await validateWasiImports(await readFile(artifact, { signal }), "skill test", signal);
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
				{ cwd: workspace, timeoutMs: deadline - Date.now(), signal },
			);
			requireSuccess(result, "sandboxed skill tests");
			const summary = /^test result: ok\. (\d+) passed; 0 failed;/m.exec(result.stdout);
			if (!summary) throw new Error("skill tests require the standard Rust test harness");
			passed += Number(summary[1]);
		}
		if (passed === 0) throw new Error("skill registration requires at least one passing, non-ignored test");
	} catch (error) {
		options.signal?.throwIfAborted();
		if (timeout.aborted) throw new Error("sandboxed skill tests timed out");
		throw error;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
