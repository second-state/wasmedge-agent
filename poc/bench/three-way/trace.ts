import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MeasurementState, Outcome, RunSlot, Span } from "./types.js";

export type StopSpan = ((outcome?: Outcome) => Span) & { spanId: string };

export class Trace {
	readonly clockId = `collector:${process.pid}:${randomUUID()}`;
	readonly spans: Span[] = [];
	private readonly active = new Map<
		string,
		{ name: string; start: bigint; parentSpanId: string | null; attributes: Record<string, unknown> }
	>();
	constructor(
		readonly directory: string,
		readonly slot: RunSlot,
	) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}

	event(type: string, attributes: Record<string, unknown>): void {
		appendFileSync(
			join(this.directory, "events.jsonl"),
			`${JSON.stringify({ type, clockId: this.clockId, monoNs: process.hrtime.bigint().toString(), ...attributes })}\n`,
			{ mode: 0o600 },
		);
	}

	start(name: string, attributes: Record<string, unknown> = {}, parentSpanId: string | null = null): StopSpan {
		const start = process.hrtime.bigint();
		const spanId = randomUUID();
		this.active.set(spanId, { name, start, parentSpanId, attributes });
		this.event("span_start", { name, spanId, parentSpanId, attributes });
		let completed: Span | undefined;
		return Object.assign(
			(outcome: Outcome = "ok") => {
				if (completed) return completed;
				this.active.delete(spanId);
				const end = process.hrtime.bigint();
				completed = this.add({
					name,
					spanId,
					parentSpanId,
					startMonoNs: start.toString(),
					endMonoNs: end.toString(),
					durationMs: Number(end - start) / 1e6,
					measurementState: "measured",
					outcome,
					attributes,
				});
				return completed;
			},
			{ spanId },
		);
	}

	discard(stop: StopSpan): void {
		this.active.delete(stop.spanId);
	}

	finishIncomplete(outcome: "error" | "timeout" | "aborted" | "unknown"): void {
		for (const [spanId, value] of this.active)
			this.add({
				name: value.name,
				spanId,
				parentSpanId: value.parentSpanId,
				startMonoNs: value.start.toString(),
				endMonoNs: null,
				durationMs: null,
				measurementState: "incomplete",
				outcome,
				reason: "Span started without an observed completion boundary",
				attributes: value.attributes,
			});
		this.active.clear();
	}

	duration(name: string, durationMs: number, attributes: Record<string, unknown> = {}, outcome: Outcome = "ok"): Span {
		if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error(`Invalid measured duration: ${name}`);
		// Legacy summaries supply duration, not a shared timeline origin. Each
		// observation gets an isolated clock; never align these with collector spans.
		return this.add({
			name,
			startMonoNs: "0",
			endMonoNs: BigInt(Math.round(durationMs * 1e6)).toString(),
			durationMs,
			clockId: `duration-only:${randomUUID()}`,
			measurementState: "measured",
			outcome,
			attributes: { ...attributes, timingKind: "duration-only" },
		});
	}

	unavailable(
		name: string,
		state: Exclude<MeasurementState, "measured" | "incomplete">,
		reason: string,
		attributes: Record<string, unknown> = {},
	): Span {
		return this.add({
			name,
			startMonoNs: null,
			endMonoNs: null,
			durationMs: null,
			clockId: null,
			processId: null,
			measurementState: state,
			outcome: state === "missing" ? "unknown" : state,
			reason,
			attributes,
		});
	}

	add(
		fields: Pick<Span, "name" | "startMonoNs" | "endMonoNs" | "durationMs" | "measurementState" | "outcome"> &
			Partial<Span>,
	): Span {
		const span: Span = {
			schemaVersion: 1,
			recordId: randomUUID(),
			runId: this.slot.runId,
			variantId: this.slot.variantId,
			benchmarkId: this.slot.caseId,
			agentId: "root",
			spanId: randomUUID(),
			parentSpanId: null,
			processId: process.pid,
			clockId: this.clockId,
			attributes: {},
			counters: {},
			...fields,
		};
		for (const key of ["turnId", "requestId", "toolCallId", "cellId", "commandId", "repairChainId"] as const) {
			if (typeof span.attributes[key] === "string" && !span[key]) span[key] = span.attributes[key] as string;
		}
		if (typeof span.attributes.requestAttempt === "number") span.requestAttempt ??= span.attributes.requestAttempt;
		this.spans.push(span);
		appendFileSync(join(this.directory, "spans.jsonl"), `${JSON.stringify(span)}\n`, { mode: 0o600 });
		this.event("span_end", { spanId: span.spanId, outcome: span.outcome, measurementState: span.measurementState });
		return span;
	}
}
