import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { record, sha256 } from "./files.js";
import type { Prepared } from "./prepare.js";
import { killOwned, type OwnedProcess } from "./process.js";
import type { Trace } from "./trace.js";
import type { Case, Outcome, VariantId } from "./types.js";
import { isWasmVariant } from "./types.js";
import { verifyFixtureInputs, verifyWorkload } from "./workloads/fixtures.js";

export class RuntimeDeadlineError extends Error {}

export function importCell(trace: Trace, value: unknown, attributes: Record<string, unknown>): void {
	if (!record(value)) return;
	const outcome: Outcome = ["ok", "error", "timeout", "aborted", "compile_error"].includes(String(value.status))
		? (value.status as Outcome)
		: "error";
	const timings = record(value.timings) ? value.timings : null;
	const names: Record<string, string> = {
		prepareMs: "cell.source_prepare",
		skillValidationMs: "cell.skill_validation",
		libraryTestsMs: "cell.library_tests",
		buildQueueMs: "cell.build_queue",
		cargoMs: "cell.compile",
		rollbackMs: "cell.rollback",
		importPolicyMs: "cell.import_policy",
		probeMs: "cell.probe",
		aotCompileMs: "cell.aot_compile",
		executionMs: "cell.execution",
		bridgeCleanupMs: "cell.bridge_cleanup",
		snapshotMs: "cell.snapshot",
		otherMs: "cell.other",
		queueMs: "cell.queue",
	};
	if (timings) {
		for (const [key, name] of Object.entries(names)) {
			const duration = timings[key];
			if (key === "aotCompileMs" && value.runtimeMode !== "aot") {
				trace.unavailable(name, "not_applicable", "Interpreter has no Wasm-to-AOT phase", attributes);
				continue;
			}
			if (key === "aotCompileMs" && outcome === "compile_error") {
				trace.unavailable(name, "not_run", "Cargo rejected the cell before AOT compilation", attributes);
				continue;
			}
			if (typeof duration !== "number") {
				trace.unavailable(name, "missing", "Runtime summary omitted phase", attributes);
				continue;
			}
			if ((outcome === "compile_error" || value.aotCompileFailed) && key === "executionMs")
				trace.unavailable(name, "not_run", "Compilation rejected the cell", attributes);
			else
				trace.duration(
					name,
					duration,
					{
						...attributes,
						source: "runtime-summary-v1",
						phasePartition: "exclusive-runner-phases",
						provenance: "child-runtime-reported",
					},
					key === "executionMs" ||
						(key === "aotCompileMs" && value.aotCompileFailed) ||
						(key === "cargoMs" && outcome === "compile_error")
						? outcome
						: "ok",
				);
		}
	} else {
		trace.unavailable("cell.compile", "not_applicable", "Python runtime has no Cargo compilation phase", attributes);
		trace.unavailable("cell.aot_compile", "not_applicable", "Python runtime has no Wasm-to-AOT phase", attributes);
		trace.unavailable(
			"cell.python_prepare",
			"missing",
			"Pinned upstream runtime does not expose parse/bytecode/import boundaries",
			attributes,
		);
		if (typeof value.durationMs === "number")
			trace.duration(
				"cell.python_execute",
				value.durationMs,
				{ ...attributes, source: "kernel-execute-summary", provenance: "child-runtime-reported" },
				outcome,
			);
	}
	if (record(value.toolTiming))
		for (const [key, name] of [
			["provisionMs", "cell.provision"],
			["totalMs", "cell.tool_total"],
		]) {
			if (typeof value.toolTiming[key] === "number")
				trace.duration(
					name,
					value.toolTiming[key] as number,
					{ ...attributes, inclusive: true, source: "runtime-tool-summary" },
					outcome,
				);
		}
	if (typeof value.stdout === "string")
		for (const line of value.stdout.split("\n")) {
			const marker = ["BENCH_COUNTERS:", "BENCH_LIBRARY:"].find((prefix) => line.startsWith(prefix));
			if (marker) {
				try {
					const details: unknown = JSON.parse(line.slice(marker.length));
					if (record(details))
						trace.event(marker === "BENCH_COUNTERS:" ? "workload_counters" : "workload_library", {
							...attributes,
							...details,
						});
				} catch {
					// Raw stdout retains malformed markers for inspection.
				}
				continue;
			}
			if (!line.startsWith("BENCH_PHASE:")) continue;
			let phase: unknown;
			try {
				phase = JSON.parse(line.slice(12));
			} catch {
				continue;
			}
			if (record(phase) && typeof phase.name === "string" && typeof phase.durationMs === "number")
				trace.duration(phase.name, phase.durationMs, {
					...attributes,
					source: "reference-guest-marker",
					provenance: "guest-local-monotonic-duration",
				});
		}
}

export async function directRuntime(
	prepared: Prepared,
	variant: VariantId,
	item: Case,
	trace: Trace,
	env: NodeJS.ProcessEnv,
	project: string,
	workspace: string,
	deadline: number,
): Promise<boolean> {
	const launcher = prepared.runtimeCommands[variant];
	if (!launcher) throw new Error("Runtime adapter absent");
	const child = spawn(launcher.command, launcher.args, {
		cwd: project,
		env: {
			...env,
			BENCH_PROJECT: project,
			BENCH_RUNTIME_MODE: variant === "wasmedge-aot" ? "aot" : "interpreter",
			BENCH_WORKSPACE: workspace,
			BENCH_PYTHON: isWasmVariant(variant)
				? undefined
				: join(prepared.variants[0].sourceRoot, `../${variant}-venv/bin/python`),
		},
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const owned: OwnedProcess = {
		child,
		exited: false,
		closed: new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => {
				owned.exited = true;
				resolve(code);
			});
		}),
	};
	void owned.closed.catch(() => {});
	const pending = new Map<
		string,
		{ resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
	>();
	let currentCell: string | null = null;
	child.stderr?.on("data", (chunk: Buffer) =>
		appendFileSync(join(trace.directory, "runtime.stderr.log"), chunk, { mode: 0o600 }),
	);
	const lines = createInterface({ input: child.stdout! });
	lines.on("line", (line) => {
		appendFileSync(join(trace.directory, "runtime.jsonl"), `${line}\n`, { mode: 0o600 });
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return;
		}
		if (!record(value)) return;
		if (typeof value.event === "string" && typeof value.durationMs === "number")
			trace.duration(
				value.event === "native_command" ? "project.program_run" : "bridge.host_handler",
				value.durationMs,
				{ cellId: currentCell, pid: child.pid, source: "adapter-handler-local-duration", bytes: value.bytes },
			);
		if (typeof value.id === "string") {
			pending.get(value.id)?.resolve(value);
			pending.delete(value.id);
		}
	});
	void owned.closed
		.finally(() => {
			for (const waiter of pending.values()) waiter.reject(new Error("Runtime adapter exited during request"));
			pending.clear();
		})
		.catch(() => {});
	async function call(
		op: string,
		fields: Record<string, unknown> = {},
		attributes: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		const id = randomUUID();
		currentCell = id;
		const stop = trace.start(op === "execute" ? "cell.roundtrip" : `runtime.${op.replaceAll("-", "_")}`, {
			cellId: id,
			inputSha256: typeof fields.code === "string" ? sha256(fields.code) : null,
			op,
			adapterPid: child.pid,
			...attributes,
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const value = await new Promise<Record<string, unknown>>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				timer = setTimeout(
					() => {
						pending.delete(id);
						reject(new RuntimeDeadlineError("Runtime request deadline exceeded"));
					},
					Math.max(1, deadline - Date.now()),
				);
				child.stdin?.write(`${JSON.stringify({ id, op, ...fields })}\n`);
			});
			stop(
				["ok", "error", "timeout", "aborted", "compile_error"].includes(String(value.status))
					? (value.status as Outcome)
					: "error",
			);
			if (op === "execute") importCell(trace, value.result, { cellId: id, adapterPid: child.pid, ...attributes });
			return value;
		} catch (error) {
			stop(error instanceof RuntimeDeadlineError ? "timeout" : "error");
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	try {
		const start = await call("start");
		if (start.status !== "ok") throw new Error("Runtime bootstrap failed; inspect runtime.jsonl");
		let pass = true;
		for (const step of item.runtime?.[variant] ?? []) {
			if (step.workloadBatch !== undefined) {
				if (item.workload)
					rmSync(
						join(project, `result-${step.workloadBatch}.${item.workload.kind === "events" ? "json" : "bin"}`),
						{ force: true },
					);
				writeFileSync(join(project, "batch-index.txt"), `${step.workloadBatch}\n`);
			}
			const attributes = { warmup: step.warmup ?? false, batch: step.workloadBatch ?? null };
			const value = await call(
				step.op,
				{ code: step.code, lib: step.lib, abortAfterMs: step.abortAfterMs },
				attributes,
			);
			const details = record(value.result) ? value.result : {};
			const output = String(details.stdout ?? "");
			let correct =
				step.expectedStatus.includes(String(value.status)) &&
				(!step.stdoutIncludes || output.includes(step.stdoutIncludes)) &&
				!details.workspaceCommitError;
			if (item.workload && step.workloadBatch !== undefined) {
				const checked = trace.start("task.workload_check", { cellId: currentCell, ...attributes });
				const oracle = verifyWorkload(project, join(trace.directory, "oracle"), item.workload, step.workloadBatch);
				checked(oracle.pass && correct ? "ok" : "error");
				trace.event("workload_oracle", { cellId: currentCell, ...attributes, ...oracle, runtimePass: correct });
				correct &&= oracle.pass;
			}
			trace.event("runtime_oracle", {
				cellId: currentCell,
				pass: correct,
				expectedStatus: step.expectedStatus,
				actualStatus: value.status,
			});
			pass &&= correct;
			if (item.workload && !correct) break;
		}
		if (item.workload) {
			const checked = trace.start("task.fixture_check");
			const intact = verifyFixtureInputs(project, join(trace.directory, "oracle"));
			checked(intact ? "ok" : "error");
			pass &&= intact;
		}
		await call("dispose");
		child.stdin?.end();
		await owned.closed;
		return pass;
	} finally {
		lines.close();
		await killOwned(owned);
	}
}
