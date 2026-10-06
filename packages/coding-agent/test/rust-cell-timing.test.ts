import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeServer } from "../src/core/rust-cell/bridge-server.js";
import { CellRunner } from "../src/core/rust-cell/cell-runner.js";
import { CELL_PHASES } from "../src/core/rust-cell/cell-timing.js";
import type { CellResult } from "../src/core/rust-cell/types.js";
import { WorkspaceHistory } from "../src/core/rust-cell/workspace-history.js";

const simulated = vi.hoisted(() => ({ now: 0, buildExit: 0, runExit: 0, rejected: false, aborted: false }));
vi.mock("../src/core/rust-cell/build-gate.js", () => ({
	withBuildPermit: async (action: () => Promise<unknown>, signal: AbortSignal) => {
		simulated.now += 20;
		signal.throwIfAborted();
		return action();
	},
}));
vi.mock("../src/core/rust-cell/process.js", () => ({
	runProcess: async (bin: string, args: string[]) => {
		const build = bin === "cargo";
		const probe = args.at(-1)?.endsWith("probe.wasm");
		simulated.now += build ? 100 : probe ? 3 : 40;
		return {
			exitCode: build ? simulated.buildExit : simulated.runExit,
			stdout: "",
			stderr: "",
			timedOut: false,
			aborted: !build && !probe && simulated.aborted,
		};
	},
}));
vi.mock("../src/core/rust-cell/wasm-imports.js", () => ({
	validateWasiImports: async () => {
		simulated.now += 5;
		if (simulated.rejected) throw new Error("forbidden import");
	},
}));
vi.mock("../src/core/rust-cell/library-tests.js", () => ({
	normalizeLibraryTestGate: (value: unknown) => value === true,
	testLibraryEdits: async () => {
		simulated.now += 60;
	},
}));

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	Object.assign(simulated, { now: 0, buildExit: 0, runExit: 0, rejected: false, aborted: false });
	vi.spyOn(performance, "now").mockImplementation(() => simulated.now);
	// The wall clock must not affect measured phases or deadline arithmetic.
	vi.spyOn(Date, "now").mockImplementation(() => 1_000_000 - simulated.now);
	const ws = mkdtempSync(join(tmpdir(), "cell-timing-"));
	roots.push(ws);
	for (const dir of ["cell/src", "agent_lib/src/helpers", "target/wasm32-wasip1/release"])
		mkdirSync(join(ws, dir), { recursive: true });
	writeFileSync(join(ws, "cell/src/main.rs"), "fn main() {}");
	writeFileSync(join(ws, "target/wasm32-wasip1/release/cell.wasm"), "fixture");
	const bridge = new BridgeServer({ handlers: {} });
	vi.spyOn(bridge, "beginCell").mockImplementation(() => {
		simulated.now += 2;
	});
	vi.spyOn(bridge, "endCell").mockImplementation(async () => {
		simulated.now += 7;
	});
	const history = new WorkspaceHistory(ws);
	const snapshot = vi.spyOn(history, "snapshot").mockImplementation(() => {
		simulated.now += 11;
		return "commit";
	});
	const runner = new CellRunner({
		cwd: ws,
		workspaceDir: ws,
		cargoBin: "cargo",
		wasmedgeBin: "wasmedge",
		cellTimeoutMs: 30_000,
		bridge,
		history,
		libraryTestGate: true,
		validateSkills: async () => {
			simulated.now += 13;
		},
	});
	return { runner, snapshot };
}

function partition(result: CellResult) {
	expect(result.timings?.version).toBe(1);
	for (const key of CELL_PHASES) expect(result.timings![key]).toBeGreaterThanOrEqual(0);
	expect(CELL_PHASES.reduce((sum, key) => sum + result.timings![key], 0)).toBeCloseTo(result.durationMs, 8);
}

describe("cell phase timing", () => {
	it("separates admission, validation, execution, cleanup and snapshots without overlap", async () => {
		const { runner } = fixture();
		const first = await runner.execute({
			code: "fn main() {}",
			lib: [{ path: "src/helpers/new.rs", content: "pub fn new() {}" }],
		});
		partition(first);
		expect(first).toMatchObject({ status: "ok", compileMs: 120, runMs: 47, durationMs: 261 });
		expect(first.timings).toMatchObject({
			queueMs: 0,
			skillValidationMs: 13,
			libraryTestsMs: 60,
			buildQueueMs: 20,
			cargoMs: 100,
			importPolicyMs: 5,
			probeMs: 3,
			executionMs: 40,
			bridgeCleanupMs: 7,
			snapshotMs: 11,
			otherMs: 2,
		});
		const second = await runner.execute({ code: "fn main() {}" });
		partition(second);
		expect(second.timings).toMatchObject({ probeMs: 0, libraryTestsMs: 0 });
	});

	it.each(["compile", "policy", "runtime", "abort", "snapshot"])("retains timing for %s failure", async (phase) => {
		const { runner, snapshot } = fixture();
		if (phase === "compile") simulated.buildExit = 1;
		if (phase === "policy") simulated.rejected = true;
		if (phase === "runtime") simulated.runExit = 1;
		if (phase === "abort") simulated.aborted = true;
		if (phase === "snapshot")
			snapshot.mockImplementation(() => {
				simulated.now += 11;
				throw new Error("snapshot failed");
			});
		const result = await runner.execute({ code: "fn main() {}" });
		partition(result);
		if (phase === "compile" || phase === "policy") expect(result.timings?.executionMs).toBe(0);
		if (phase !== "snapshot") expect(result.timings?.snapshotMs).toBe(0);
		else {
			expect(result.workspaceCommitError).toBe("snapshot failed");
			expect(result.timings?.snapshotMs).toBe(11);
		}
	});

	it("accounts for the runner queue outside admitted duration and reports pre-cancelled cells", async () => {
		const { runner } = fixture();
		const first = runner.execute({ code: "fn main() {}" });
		const second = runner.execute({ code: "fn main() {}" });
		const a = await first;
		const b = await second;
		partition(b);
		expect(b.timings?.queueMs).toBe(a.durationMs);
		const controller = new AbortController();
		controller.abort();
		const cancelled = await runner.execute({ code: "fn main() {}" }, { signal: controller.signal });
		partition(cancelled);
		expect(cancelled).toMatchObject({ status: "aborted", durationMs: 0 });
		expect(cancelled.timings?.cargoMs).toBe(0);
	});
});
