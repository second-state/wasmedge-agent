import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { record, StreamArtifact, sha256, writeJson } from "./files.js";
import { credentials } from "./provider.js";
import type { Trace } from "./trace.js";
import type { Provider, ReplayStep } from "./types.js";

export class SseDecoder {
	private pending = "";
	private readonly decoder = new TextDecoder();
	constructor(private readonly consume: (data: string) => void) {}
	push(chunk: Uint8Array, final = false): void {
		this.pending += this.decoder.decode(chunk, { stream: !final });
		while (true) {
			const match = /\r?\n\r?\n/.exec(this.pending);
			if (!match) break;
			const block = this.pending.slice(0, match.index);
			this.pending = this.pending.slice(match.index + match[0].length);
			const data = block
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""))
				.join("\n");
			if (data) this.consume(data);
		}
		if (final && this.pending.trim()) throw new Error("Truncated SSE frame");
	}
}

export function replayChunks(step: ReplayStep, model: string, index: number): Buffer[] {
	const chunks: Buffer[] = [];
	const emit = (delta: unknown, finishReason: string | null = null) =>
		chunks.push(
			Buffer.from(
				`data: ${JSON.stringify({ id: `replay-${index}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
			),
		);
	emit({ role: "assistant" });
	const split = (value: string) => {
		// Divide Unicode code points, never UTF-8 bytes inside a JSON string.
		const chars = Array.from(value),
			size = step.chunkBytes ?? 16;
		return Array.from({ length: Math.ceil(chars.length / size) }, (_, n) =>
			chars.slice(n * size, (n + 1) * size).join(""),
		);
	};
	for (const fragment of split(step.reasoning ?? "")) emit({ reasoning_content: fragment });
	for (const fragment of split(step.text ?? "")) emit({ content: fragment });
	if (step.tool) {
		emit({
			tool_calls: [
				{ index: 0, id: `call-${index}`, type: "function", function: { name: step.tool.name, arguments: "" } },
			],
		});
		for (const fragment of split(JSON.stringify(step.tool.arguments)))
			emit({ tool_calls: [{ index: 0, function: { arguments: fragment } }] });
	}
	emit({}, step.tool ? "tool_calls" : "stop");
	chunks.push(Buffer.from("data: [DONE]\n\n"));
	return chunks;
}

export async function startGateway(options: {
	trace: Trace;
	modelId: string;
	provider: Provider | null;
	replay?: ReplayStep[];
	limit: number;
	signal: AbortSignal;
}) {
	const { trace, modelId, provider, replay, limit, signal } = options;
	const anthropic = provider?.api === "anthropic-messages";
	const token = randomUUID();
	const apiKey = provider ? credentials().apiKey : null;
	const sanitize = (value: string) => (apiKey ? value.replaceAll(apiKey, "[REDACTED]") : value);
	let count = 0;
	const inflight = new Set<Promise<void>>();
	const server = createServer((request, response) => {
		const operation = handle(response);
		inflight.add(operation);
		void operation.finally(() => inflight.delete(operation)).catch(() => {});
		async function handle(res: ServerResponse): Promise<void> {
			if (
				request.url !== (anthropic ? "/v1/messages" : "/v1/chat/completions") ||
				request.method !== "POST" ||
				(anthropic ? request.headers["x-api-key"] !== token : request.headers.authorization !== `Bearer ${token}`)
			) {
				res.writeHead(404).end();
				return;
			}
			const number = ++count;
			if (number > limit) {
				res.writeHead(429).end('{"error":{"message":"Benchmark request limit reached"}}');
				return;
			}
			const requestId = `request-${number}`;
			const attributes = { requestId, requestAttempt: number, timingBoundary: "gateway-receipt" };
			const total = trace.start("llm.request", attributes);
			const receive = trace.start("llm.receive_body", attributes, total.spanId);
			const chunks: Buffer[] = [];
			const artifact = new StreamArtifact(join(trace.directory, `${requestId}.response.sse`), apiKey);
			const receivedAt = process.hrtime.bigint();
			const tools = new Map<
				number,
				{
					name: string;
					id: string | null;
					arguments: string;
					first: bigint | null;
					last: bigint | null;
					fragments: { begin: number; end: number; time: bigint }[];
				}
			>();
			const firstStops = new Map<string, ReturnType<Trace["start"]>>();
			for (const kind of ["byte", "token", "text", "reasoning", "tool_arguments"])
				firstStops.set(kind, trace.start(`llm.time_to_first_${kind}`, attributes, total.spanId));
			const observed = new Set<string>();
			const responseModelIds = new Set<string>();
			const completionIds = new Set<string>();
			let usage: unknown = null,
				upstreamStatus: number | null = null,
				done = false;
			const nativeUsage: Record<string, unknown> = {};
			const first = (kind: string) => {
				if (!observed.has(kind)) {
					observed.add(kind);
					firstStops.get(kind)?.();
				}
			};
			const appendTool = (index: number, fragment: string, name = "", id: string | null = null) => {
				const tool = tools.get(index) ?? {
					name: "",
					id: null,
					arguments: "",
					first: null,
					last: null,
					fragments: [],
				};
				tool.name += name;
				tool.id = id ?? tool.id;
				if (fragment.length) {
					const now = process.hrtime.bigint(),
						begin = tool.arguments.length;
					tool.arguments += fragment;
					tool.fragments.push({ begin, end: tool.arguments.length, time: now });
					tool.first ??= now;
					tool.last = now;
					first("tool_arguments");
					first("token");
				}
				tools.set(index, tool);
			};
			const decoder = new SseDecoder((data) => {
				if (data === "[DONE]") {
					done = true;
					return;
				}
				let value: unknown;
				try {
					value = JSON.parse(data);
				} catch {
					throw new Error("Invalid upstream SSE JSON");
				}
				if (!record(value)) return;
				if (anthropic) {
					if (value.type === "error") throw new Error("Upstream Anthropic stream error; inspect SSE artifact");
					if (value.type === "message_start" && record(value.message)) {
						if (typeof value.message.model === "string") responseModelIds.add(sanitize(value.message.model));
						if (typeof value.message.id === "string") completionIds.add(sanitize(value.message.id));
						if (record(value.message.usage)) Object.assign(nativeUsage, value.message.usage);
					}
					if (record(value.usage)) Object.assign(nativeUsage, value.usage);
					if (typeof nativeUsage.input_tokens === "number" && typeof nativeUsage.output_tokens === "number") {
						const prompt =
							nativeUsage.input_tokens +
							Number(nativeUsage.cache_creation_input_tokens ?? 0) +
							Number(nativeUsage.cache_read_input_tokens ?? 0);
						usage = {
							prompt_tokens: prompt,
							completion_tokens: nativeUsage.output_tokens,
							total_tokens: prompt + nativeUsage.output_tokens,
						};
					}
					if (value.type === "message_stop") done = true;
					if (value.type === "content_block_start" && record(value.content_block)) {
						const block = value.content_block;
						if (block.type === "tool_use" && typeof block.name === "string")
							appendTool(
								Number(value.index),
								record(block.input) && Object.keys(block.input).length ? JSON.stringify(block.input) : "",
								block.name,
								typeof block.id === "string" ? block.id : null,
							);
					}
					if (value.type === "content_block_delta" && record(value.delta)) {
						const delta = value.delta;
						if (delta.type === "input_json_delta" && typeof delta.partial_json === "string")
							appendTool(Number(value.index), delta.partial_json);
						for (const [field, kind] of [
							["text", "text"],
							["thinking", "reasoning"],
						]) {
							if (typeof delta[field] === "string" && delta[field].length) {
								first(kind);
								first("token");
							}
						}
					}
					return;
				}
				if (typeof value.model === "string") responseModelIds.add(sanitize(value.model));
				if (typeof value.id === "string") completionIds.add(sanitize(value.id));
				if (value.usage) usage = value.usage;
				if (!Array.isArray(value.choices)) return;
				for (const choice of value.choices) {
					if (!record(choice) || !record(choice.delta)) continue;
					const delta = choice.delta;
					for (const [field, kind] of [
						["content", "text"],
						["reasoning_content", "reasoning"],
						["reasoning", "reasoning"],
					]) {
						if (typeof delta[field] === "string" && delta[field].length) {
							first(kind);
							first("token");
						}
					}
					if (!Array.isArray(delta.tool_calls)) continue;
					for (const call of delta.tool_calls) {
						if (!record(call) || !record(call.function)) continue;
						appendTool(
							Number(call.index ?? 0),
							typeof call.function.arguments === "string" ? call.function.arguments : "",
							typeof call.function.name === "string" ? call.function.name : "",
							typeof call.id === "string" ? call.id : null,
						);
					}
				}
			});
			try {
				const bodyChunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of request) {
					const bytes = Buffer.from(chunk);
					size += bytes.length;
					if (size > 32 * 1024 * 1024) throw new Error("Request body exceeds benchmark limit");
					bodyChunks.push(bytes);
				}
				const body = Buffer.concat(bodyChunks);
				receive();
				const payload: unknown = JSON.parse(body.toString());
				if (!record(payload) || payload.model !== modelId || payload.stream !== true)
					throw new Error("Gateway requires the pinned model and streaming");
				writeFileSync(join(trace.directory, `${requestId}.request.json`), sanitize(body.toString()), {
					mode: 0o600,
				});
				trace.event("llm_request", {
					...attributes,
					bodySha256: sha256(body),
					bytes: body.length,
					parentSpanId: total.spanId,
				});
				const headers = trace.start("llm.upstream_headers", attributes, total.spanId);
				let stream: AsyncIterable<Uint8Array>;
				if (replay) {
					const step = replay[number - 1];
					if (!step) throw new Error("Replay exhausted");
					stream = (async function* () {
						for (const chunk of replayChunks(step, modelId, number)) {
							if (signal.aborted) throw new Error("Aborted");
							if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
							yield chunk;
						}
					})();
					upstreamStatus = 200;
				} else {
					if (!provider || !apiKey) throw new Error("Provider missing");
					const upstreamHeaders: Record<string, string> = anthropic
						? {
								"x-api-key": apiKey,
								"anthropic-version": String(request.headers["anthropic-version"] ?? "2023-06-01"),
								"Content-Type": "application/json",
							}
						: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
					if (anthropic && typeof request.headers["anthropic-beta"] === "string")
						upstreamHeaders["anthropic-beta"] = request.headers["anthropic-beta"];
					const upstream = await fetch(`${provider.baseUrl}${anthropic ? "/v1/messages" : "/chat/completions"}`, {
						method: "POST",
						headers: upstreamHeaders,
						body,
						signal,
					});
					upstreamStatus = upstream.status;
					if (!upstream.ok || !upstream.body) {
						const errorBody = sanitize((await upstream.text()).slice(0, 131072));
						writeFileSync(join(trace.directory, `${requestId}.upstream-error.txt`), errorBody, { mode: 0o600 });
						throw new Error(`Upstream HTTP ${upstream.status}`);
					}
					stream = upstream.body;
				}
				headers();
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
				const streaming = trace.start("llm.stream", attributes, total.spanId);
				try {
					for await (const chunk of stream) {
						first("byte");
						chunks.push(Buffer.from(chunk));
						artifact.push(chunk);
						decoder.push(chunk);
						trace.event("llm_chunk", { ...attributes, bytes: chunk.length });
						if (!res.destroyed) res.write(chunk);
					}
					decoder.push(new Uint8Array(), true);
					if (anthropic && !done) throw new Error("Anthropic stream ended before message_stop");
					// Some compliant providers terminate after finish_reason without [DONE].
					streaming();
					total();
					res.end();
				} catch (error) {
					streaming(signal.aborted ? "aborted" : "error");
					throw error;
				}
			} catch (error) {
				receive("error");
				total(signal.aborted ? "aborted" : "error");
				trace.event("gateway_error", {
					...attributes,
					message: sanitize(error instanceof Error ? error.message : "Gateway error"),
				});
				if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
				if (!res.destroyed) res.end('{"error":{"message":"Benchmark gateway failed; inspect local artifacts"}}');
			} finally {
				artifact.push(new Uint8Array(), true);
				for (const kind of firstStops.keys())
					if (!observed.has(kind)) {
						trace.discard(firstStops.get(kind)!);
						trace.unavailable(
							`llm.time_to_first_${kind}`,
							"not_run",
							"Stream did not contain this output type",
							attributes,
						);
					}
				for (const [index, tool] of tools) {
					if (tool.first && tool.last)
						trace.add({
							name: "llm.tool_arguments_generation",
							startMonoNs: tool.first.toString(),
							endMonoNs: tool.last.toString(),
							durationMs: Number(tool.last - tool.first) / 1e6,
							measurementState: "measured",
							outcome: "ok",
							parentSpanId: total.spanId,
							requestId,
							attributes: {
								...attributes,
								toolName: tool.name,
								toolCallId: tool.id,
								boundary: "first-to-last-tool-argument-SSE-event",
								bytes: Buffer.byteLength(tool.arguments),
							},
						});
					let argumentsValue: unknown;
					try {
						argumentsValue = JSON.parse(sanitize(tool.arguments));
					} catch {
						argumentsValue = null;
					}
					if (argumentsValue !== null && ["rust", "ipython"].includes(tool.name)) {
						const pattern = /"(code|content)"\s*:\s*("(?:\\[\s\S]|[^"\\])*")/g;
						for (const match of tool.arguments.matchAll(pattern)) {
							const encoded = match[2],
								begin = match.index + match[0].length - encoded.length + 1,
								end = begin + encoded.length - 2;
							const firstFragment = tool.fragments.find((fragment) => fragment.end > begin),
								lastFragment = [...tool.fragments].reverse().find((fragment) => fragment.begin < end);
							if (!firstFragment || !lastFragment || lastFragment.time < firstFragment.time) continue;
							const source: unknown = JSON.parse(encoded);
							const attrs = {
								...attributes,
								toolName: tool.name,
								toolCallId: tool.id,
								artifactRole: match[1] === "code" ? "control_cell" : "helper_library",
								sourceBytes: typeof source === "string" ? Buffer.byteLength(source) : null,
								boundary: "source-field-byte-range-mapped-to-gateway-SSE-events",
								inclusive: true,
							};
							trace.add({
								name: "llm.code_emission",
								startMonoNs: firstFragment.time.toString(),
								endMonoNs: lastFragment.time.toString(),
								durationMs: Number(lastFragment.time - firstFragment.time) / 1e6,
								measurementState: "measured",
								outcome: "ok",
								parentSpanId: total.spanId,
								requestId,
								attributes: attrs,
							});
							trace.add({
								name: "llm.code_ready",
								startMonoNs: receivedAt.toString(),
								endMonoNs: lastFragment.time.toString(),
								durationMs: Number(lastFragment.time - receivedAt) / 1e6,
								measurementState: "measured",
								outcome: "ok",
								parentSpanId: total.spanId,
								requestId,
								attributes: attrs,
							});
						}
					}
					writeJson(join(trace.directory, `${requestId}.tool-${index}.json`), {
						toolCallId: tool.id,
						name: tool.name,
						arguments: argumentsValue,
						rawArguments: sanitize(tool.arguments),
						complete: argumentsValue !== null,
					});
				}
				writeJson(join(trace.directory, `${requestId}.json`), {
					requestId,
					upstreamStatus,
					responseModelIds: [...responseModelIds],
					completionIds: [...completionIds],
					doneMarker: done,
					usage,
					...(anthropic
						? {
								api: provider.api,
								nativeUsage,
								inputTokenAccounting: "input + cache_creation_input + cache_read_input",
							}
						: {}),
					responseBytes: Buffer.concat(chunks).length,
					toolCount: tools.size,
				});
			}
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Gateway address unavailable");
	return {
		baseUrl: `http://127.0.0.1:${address.port}${anthropic ? "" : "/v1"}`,
		token,
		requestCount: () => count,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await Promise.allSettled(inflight);
		},
	};
}
