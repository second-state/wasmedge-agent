import { cellComparable } from "./cell-contract.js";
import type { Case, RunResult, Span } from "./types.js";

export interface CompilationAdjustedRun {
	runId: string;
	caseId: string;
	variantId: string;
	repetition: number;
	state: "measured" | "not_run" | "unavailable" | "excluded";
	reason: string;
	compileMs: number | null;
	compileObservations: number;
	compileSpanIds: string[];
	agentMs: number | null;
	userMs: number | null;
	validatedMs: number | null;
	agentCargoMs: number | null;
	userCargoMs: number | null;
	validatedCargoMs: number | null;
	agentWithoutCompilationMs: number | null;
	userWithoutCompilationMs: number | null;
	validatedWithoutCompilationMs: number | null;
	aotCompileMs: number | null;
	aotSpanIds: string[];
	agentAotMs: number | null;
	userAotMs: number | null;
	validatedAotMs: number | null;
	agentCompilerMs: number | null;
	userCompilerMs: number | null;
	validatedCompilerMs: number | null;
	agentWithoutAllCompilationMs: number | null;
	userWithoutAllCompilationMs: number | null;
	validatedWithoutAllCompilationMs: number | null;
}

interface Interval {
	start: bigint;
	end: bigint;
	clock: string;
}
function interval(span: Span): Interval | null {
	if (
		span.measurementState !== "measured" ||
		!span.clockId ||
		span.clockId.startsWith("duration-only:") ||
		!/^\d+$/.test(span.startMonoNs ?? "") ||
		!/^\d+$/.test(span.endMonoNs ?? "") ||
		span.durationMs === null ||
		!Number.isFinite(span.durationMs) ||
		span.durationMs < 0
	)
		return null;
	const start = BigInt(span.startMonoNs!),
		end = BigInt(span.endMonoNs!);
	return end >= start && Math.abs(Number(end - start) / 1e6 - span.durationMs) <= 0.001
		? { start, end, clock: span.clockId }
		: null;
}

export function unionMs(intervals: readonly { start: bigint; end: bigint }[]): number {
	const sorted = [...intervals].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
	let total = 0n,
		start = 0n,
		end = 0n;
	for (const value of sorted) {
		if (value.start > end) {
			total += end - start;
			start = value.start;
			end = value.end;
		} else if (value.end > end) end = value.end;
	}
	return Number(total + end - start) / 1e6;
}

export function subtractCompilation(
	run: RunResult,
	spans: readonly Span[],
	_item?: Pick<Case, "lane" | "tools">,
): CompilationAdjustedRun {
	const cargo = spans.filter((span) => span.name === "cargo.command" && span.runId === run.runId);
	const aot = spans.filter((span) => span.name === "aot.command" && span.runId === run.runId);
	const valid = (value: number | null | undefined) =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
	const result: CompilationAdjustedRun = {
		runId: run.runId,
		caseId: run.caseId,
		variantId: run.variantId,
		repetition: run.repetition,
		state: "unavailable",
		reason: "missing-all-cargo-capture",
		compileMs: null,
		compileObservations: cargo.length,
		compileSpanIds: cargo.map((span) => span.spanId),
		agentMs: valid(run.agentElapsedMs),
		userMs: valid(run.userElapsedMs),
		validatedMs: valid(run.validatedElapsedMs),
		agentCargoMs: null,
		userCargoMs: null,
		validatedCargoMs: null,
		agentWithoutCompilationMs: null,
		userWithoutCompilationMs: null,
		validatedWithoutCompilationMs: null,
		aotCompileMs: null,
		aotSpanIds: aot.map((span) => span.spanId),
		agentAotMs: null,
		userAotMs: null,
		validatedAotMs: null,
		agentCompilerMs: null,
		userCompilerMs: null,
		validatedCompilerMs: null,
		agentWithoutAllCompilationMs: null,
		userWithoutAllCompilationMs: null,
		validatedWithoutAllCompilationMs: null,
	};
	if (!cellComparable(run)) return { ...result, state: "excluded", reason: "cell-comparison-contract-not-met" };
	if (run.status !== "completed" || !run.applicable || !run.checkPass)
		return { ...result, state: "excluded", reason: "not-successful-applicable-run" };
	if (
		!run.cargoCapture?.complete ||
		!run.cargoCapture.clockVerified ||
		run.cargoCapture.version !== 1 ||
		run.cargoCapture.completedCommands !== cargo.length ||
		run.cargoCapture.startedCommands !== cargo.length ||
		run.cargoCapture.errors.length
	)
		return result;
	const bounds = cargo.map(interval);
	if (
		bounds.some((value) => !value) ||
		cargo.some((span) => span.attributes.provenance !== "cargo-wrapper-command-wall") ||
		cargo.some((span) => !span.commandId) ||
		new Set(cargo.map((span) => span.commandId)).size !== cargo.length
	)
		return { ...result, reason: "invalid-cargo-clock-or-identity" };
	const actual = bounds as Interval[];
	const tasks = ["task.agent_elapsed", "run.user_elapsed", "run.validated_elapsed"].map((name) => {
		const matches = spans.filter((span) => span.runId === run.runId && span.name === name);
		return matches.length === 1 ? interval(matches[0]) : null;
	});
	if (
		!tasks[0] ||
		!tasks[1] ||
		!tasks[2] ||
		tasks.some((task) => task!.clock !== tasks[0]!.clock) ||
		actual.some((command) => command.clock !== tasks[0]!.clock)
	)
		return { ...result, reason: "missing-task-clock" };
	const raw = [result.agentMs, result.userMs, result.validatedMs];
	if (
		raw.some(
			(value, index) =>
				value === null || Math.abs(value - Number(tasks[index]!.end - tasks[index]!.start) / 1e6) > 0.001,
		)
	)
		return { ...result, reason: "elapsed-clock-mismatch" };
	const deductions = tasks.map((task) =>
		unionMs(
			actual.flatMap((command) => {
				const start = command.start > task!.start ? command.start : task!.start,
					end = command.end < task!.end ? command.end : task!.end;
				return end >= start ? [{ start, end }] : [];
			}),
		),
	);
	const aotBounds = aot.map(interval);
	const capturedAot =
		(run.variantId !== "wasmedge-aot" && !aot.length && !run.aotCapture) ||
		(run.aotCapture?.complete &&
			run.aotCapture.clockVerified &&
			run.aotCapture.version === 1 &&
			run.aotCapture.method === "aot-runtime-override" &&
			run.aotCapture.startedCommands === aot.length &&
			run.aotCapture.completedCommands === aot.length &&
			!run.aotCapture.errors.length);
	const validAot =
		capturedAot &&
		aotBounds.every((bound) => bound && bound.clock === tasks[0]!.clock) &&
		aot.every((span) => span.commandId && span.attributes.provenance === "aot-wrapper-command-wall") &&
		new Set(aot.map((span) => span.commandId)).size === aot.length;
	const deduct = (commands: Interval[]) =>
		tasks.map((task) =>
			unionMs(
				commands.flatMap((command) => {
					const start = command.start > task!.start ? command.start : task!.start;
					const end = command.end < task!.end ? command.end : task!.end;
					return end >= start ? [{ start, end }] : [];
				}),
			),
		);
	const aotDeductions = validAot ? deduct(aotBounds as Interval[]) : null;
	const compilerDeductions = validAot ? deduct([...actual, ...(aotBounds as Interval[])]) : null;
	return {
		...result,
		state: cargo.length ? "measured" : "not_run",
		reason: cargo.length ? "all-cargo-union-clipped-to-elapsed" : "complete-capture-no-cargo",
		compileMs: unionMs(actual),
		agentCargoMs: deductions[0],
		userCargoMs: deductions[1],
		validatedCargoMs: deductions[2],
		agentWithoutCompilationMs: result.agentMs! - deductions[0],
		userWithoutCompilationMs: result.userMs! - deductions[1],
		validatedWithoutCompilationMs: result.validatedMs! - deductions[2],
		aotCompileMs: validAot ? unionMs(aotBounds as Interval[]) : null,
		agentAotMs: aotDeductions?.[0] ?? null,
		userAotMs: aotDeductions?.[1] ?? null,
		validatedAotMs: aotDeductions?.[2] ?? null,
		agentCompilerMs: compilerDeductions?.[0] ?? null,
		userCompilerMs: compilerDeductions?.[1] ?? null,
		validatedCompilerMs: compilerDeductions?.[2] ?? null,
		agentWithoutAllCompilationMs: compilerDeductions ? result.agentMs! - compilerDeductions[0] : null,
		userWithoutAllCompilationMs: compilerDeductions ? result.userMs! - compilerDeductions[1] : null,
		validatedWithoutAllCompilationMs: compilerDeductions ? result.validatedMs! - compilerDeductions[2] : null,
	};
}
