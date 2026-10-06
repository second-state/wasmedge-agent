/** Offline serial microbenchmark. No model/provider calls.
 * npx tsx poc/bench/runtime.ts --out /tmp/runtime.json [--reps 5]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RustCellProvisioner } from "../../packages/coding-agent/src/core/rust-cell/index.js";
import { isTemplateWarm, resolveToolchain, rustcVersion } from "../../packages/coding-agent/src/core/rust-cell/toolchain.js";
import { skillSourceFingerprint } from "../../packages/coding-agent/src/core/rust-cell/skill-fingerprint.js";
import type { CellInput, CellResult } from "../../packages/coding-agent/src/core/rust-cell/types.js";
import { resolveTemplateDir } from "../../packages/coding-agent/src/core/rust-cell/workspace.js";
import { createRustTool } from "../../packages/coding-agent/src/core/tools/rust.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
	const flag = process.argv[i];
	const value = process.argv[i + 1];
	if (!["--out", "--reps"].includes(flag) || options.has(flag) || !value || value.startsWith("--")) {
		throw new Error("usage: npx tsx poc/bench/runtime.ts --out path [--reps 5]");
	}
	options.set(flag, value);
}
const reps = Number(options.get("--reps") ?? 5);
if (!options.has("--out") || !Number.isInteger(reps) || reps < 1 || reps > 100) throw new Error("--out is required; --reps must be 1..100");
const out = resolve(options.get("--out")!);
const toolchain = resolveToolchain();
const template = resolveTemplateDir();
if (!isTemplateWarm()) throw new Error("Prepare the vendored release template first; see README.md");
const sourceFiles = [...new Set([
	...execFileSync("git", ["ls-files", "-z", "packages/coding-agent/src/core/rust-cell", "packages/coding-agent/src/core/tools/rust.ts", "wasmedge-agent-runtime/template"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean),
	"packages/coding-agent/src/core/rust-cell/cell-timing.ts", "poc/bench/runtime.ts",
])].sort();
function sourceHash() {
	const hash = createHash("sha256");
	for (const path of sourceFiles) hash.update(JSON.stringify(path)).update(createHash("sha256").update(readFileSync(join(repo, path))).digest());
	return hash.digest("hex");
}
const sourceSha256 = sourceHash();
const templateHash = () => skillSourceFingerprint(template, ["Cargo.toml", "Cargo.lock", ".cargo", "rlm", "agent_lib", "cell"]);
const templateSha256 = templateHash();
const samples: Record<string, unknown>[] = [];
const report = {
	version: 1, complete: false, startedAt: new Date().toISOString(), reps,
	baseRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
	worktreeDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim()),
	sourceSha256, sourceFiles, templateSha256,
	environment: { platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version, cargo: execFileSync(toolchain.cargoBin, ["--version"], { cwd: template, encoding: "utf8" }).trim(), rustc: rustcVersion(toolchain.cargoBin, template), wasmedge: toolchain.wasmedgeVersion },
	configuration: { target: "wasm32-wasip1", profile: "release", offline: true, persisted: true, bridge: "stdio", cellTimeoutMs: 120_000, gasLimit: null, memoryPageLimit: null, rustdocToolchain: null, maxConcurrentBuilds: process.env.WASMEDGE_AGENT_MAX_CONCURRENT_BUILDS ?? "auto" },
	samples,
};
// Reserve before running; never overwrite an earlier measurement.
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
const root = mkdtempSync(join(tmpdir(), "cell-microbenchmark-"));
const noop = { code: "fn main() {}" };
try {
	for (let rep = 1; rep <= reps; rep++) {
		const cwd = join(root, `project-${rep}`);
		const workspaceDir = join(root, `workspace-${rep}`);
		mkdirSync(cwd);
		const settings = { cwd, workspaceDir, cellTimeoutMs: 120_000, hostHandlers: { "bench.echo": async (payload: Record<string, unknown>) => payload } };
		let provisioner = new RustCellProvisioner(settings);
		let tool = createRustTool(cwd, { provisioner });
		async function sample(scenario: string, input: CellInput, status = "ok") {
			const response = await tool.execute(`bench-${rep}-${scenario}`, input);
			const result = response.details as CellResult;
			const { durationMs, compileMs, runMs, timings, toolTiming } = result;
			samples.push({ rep, scenario, status: result.status, inputSha256: createHash("sha256").update(JSON.stringify(input)).digest("hex"), durationMs, compileMs, runMs, timings, toolTiming, ...(result.status === "ok" ? { wasmBytes: statSync(join(workspaceDir, "target/wasm32-wasip1/release/cell.wasm")).size } : {}) });
			writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
			if (result.status !== status || result.workspaceCommitError || !timings || !toolTiming) throw new Error(`${scenario}: ${result.status}: ${result.compileDiagnostics || result.stderr || result.workspaceCommitError}`);
			console.error(`${rep}/${reps} ${scenario}: runner ${durationMs.toFixed(1)} ms, tool ${toolTiming.totalMs.toFixed(1)} ms`);
		}
		try {
			await sample("template-first", noop);
			await sample("unchanged", noop);
			await sample("cell-edit", { code: `fn main() { assert_eq!(${rep} + 1, ${rep + 1}); }` });
			await sample("library-edit", { code: `fn main() { assert_eq!(agent_lib::helpers::bench::answer(), ${rep}); }`, lib: [{ path: "src/helpers/bench.rs", content: `pub fn answer() -> u32 { ${rep} }` }] });
			await sample("bridge-100", { code: 'use agent_lib::prelude::*; fn main() -> Result<()> { for n in 0..100 { let v = rlm::host_request("bench.echo", serde_json::json!({"n":n}))?; assert_eq!(v["n"], n); } Ok(()) }' });
			const state = { code: 'use agent_lib::prelude::*; fn main() -> Result<()> { let bytes = vec![42u8; 65536]; rlm::state::put_blob("sample", &bytes)?; assert_eq!(rlm::state::get_blob("sample")?.unwrap(), bytes); Ok(()) }' };
			await sample("state-64k", state);
			await sample("compile-error", { code: 'fn main() { let _: u32 = "broken"; }' }, "compile_error");
			await sample("recovery", state);
			// Only this benchmark-owned target is removed; OS/toolchain caches stay warm.
			rmSync(join(workspaceDir, "target"), { recursive: true, force: true });
			await sample("cold-target", noop);
			await provisioner.dispose();
			provisioner = new RustCellProvisioner({ ...settings, libraryTestGate: true });
			tool = createRustTool(cwd, { provisioner });
			await sample("library-test-gate", { code: `fn main() { assert_eq!(agent_lib::helpers::bench::answer(), ${rep + 1}); }`, lib: [{ path: "src/helpers/bench.rs", content: `pub fn answer() -> u32 { ${rep + 1} } #[test] fn answer_works() { assert_eq!(answer(), ${rep + 1}); }` }] });
		} finally {
			await provisioner.dispose();
		}
	}
	if (sourceHash() !== sourceSha256 || templateHash() !== templateSha256) throw new Error("Measured sources changed during the benchmark");
	writeFileSync(out, `${JSON.stringify({ ...report, finishedAt: new Date().toISOString(), complete: true }, null, 2)}\n`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
