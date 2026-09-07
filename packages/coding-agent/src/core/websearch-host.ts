/** Host-side `websearch.run` handler (DESIGN.md §2.7/§4.1): guests search via
 * the bridge and the Serper API key never enters the sandbox. Query semantics,
 * result formatting, and truncation are ported from the kernel-era Python
 * websearch skill so transcripts read identically. */

import { readLegacyEnv } from "../config.js";
import type { HostRequestHandler } from "./host-bridge/types.js";

const SERPER_ENDPOINT = "https://google.serper.dev/search";
const DEFAULT_TIMEOUT_SECONDS = 45;
const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_MAX_OUTPUT_CHARS = 8192;

const NO_KEY_MESSAGE =
	"Web search is not set up yet: no Serper API key is configured.\n" +
	"Tell the user how to enable it:\n" +
	"  1. Get a free API key at https://serper.dev (sign up, copy the key).\n" +
	'  2. In WasmEdge Agent, run /login and choose "Serper (web search)", then paste the key.\n' +
	"Do not ask the user to set environment variables. Once the key is saved, web search works automatically.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function envInt(name: string, fallback: number): number {
	const parsed = Number.parseInt(readLegacyEnv(name) ?? "", 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveIntOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function formatSerperResults(data: Record<string, unknown>, query: string, numResults: number): string {
	const sections: string[] = [];

	const kg = data.knowledgeGraph;
	if (isRecord(kg)) {
		const kgLines: string[] = [];
		const title = asTrimmedString(kg.title);
		if (title) kgLines.push(`Knowledge Graph: ${title}`);
		const description = asTrimmedString(kg.description);
		if (description) kgLines.push(description);
		if (isRecord(kg.attributes)) {
			for (const [key, value] of Object.entries(kg.attributes)) {
				const text = String(value).trim();
				if (text) kgLines.push(`${key}: ${text}`);
			}
		}
		if (kgLines.length > 0) sections.push(kgLines.join("\n"));
	}

	const organic = Array.isArray(data.organic) ? data.organic : [];
	organic.slice(0, numResults).forEach((entry, index) => {
		if (!isRecord(entry)) return;
		const title = asTrimmedString(entry.title) || "Untitled";
		const lines = [`Result ${index}: ${title}`];
		const link = asTrimmedString(entry.link);
		if (link) lines.push(`URL: ${link}`);
		const snippet = asTrimmedString(entry.snippet);
		if (snippet) lines.push(snippet);
		sections.push(lines.join("\n"));
	});

	const peopleAlsoAsk = Array.isArray(data.peopleAlsoAsk) ? data.peopleAlsoAsk : [];
	if (peopleAlsoAsk.length > 0) {
		const questions: string[] = [];
		for (const item of peopleAlsoAsk.slice(0, Math.max(1, Math.min(3, peopleAlsoAsk.length)))) {
			if (!isRecord(item)) continue;
			const question = asTrimmedString(item.question);
			if (!question) continue;
			const answer = asTrimmedString(item.snippet);
			questions.push(answer ? `Q: ${question}\nA: ${answer}` : `Q: ${question}`);
		}
		if (questions.length > 0) sections.push(`People Also Ask:\n${questions.join("\n")}`);
	}

	if (sections.length === 0) return `No results returned for query: ${query}`;
	return sections.join("\n\n---\n\n");
}

export function truncateMiddle(output: string, maxOutput: number): string {
	if (output.length <= maxOutput) return output;
	const marker = `\n... [output truncated, ${output.length} chars total] ...\n`;
	const half = Math.max(0, Math.floor((maxOutput - marker.length) / 2));
	let truncated = output.slice(0, half) + marker + output.slice(output.length - half);
	if (truncated.length > maxOutput) truncated = truncated.slice(0, maxOutput);
	return truncated;
}

async function fetchSerper(query: string, apiKey: string, timeoutSeconds: number, numResults: number): Promise<string> {
	const response = await fetch(SERPER_ENDPOINT, {
		method: "POST",
		headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ q: query }),
		signal: AbortSignal.timeout(timeoutSeconds * 1000),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Serper search error (${response.status}): ${body}`);
	}
	const data: unknown = await response.json();
	return formatSerperResults(isRecord(data) ? data : {}, query, numResults);
}

export interface WebsearchHostHandlerOptions {
	/** Resolved fresh per call so a key added via /login mid-session works. */
	resolveApiKey: () => string | undefined;
	/** Test seam replacing the Serper fetch. */
	fetchImpl?: typeof fetchSerper;
}

/** Payload: `{query, num_results?, timeout?, max_output?}` → `{result}`. */
export function createWebsearchHostHandler(options: WebsearchHostHandlerOptions): HostRequestHandler {
	const doFetch = options.fetchImpl ?? fetchSerper;
	return async (payload) => {
		const query = asTrimmedString(payload.query);
		if (!query) {
			throw new Error("websearch.run requires a non-empty query");
		}
		const apiKey = options.resolveApiKey()?.trim();
		if (!apiKey) {
			return { result: NO_KEY_MESSAGE };
		}
		const timeoutSeconds = positiveIntOr(
			payload.timeout,
			envInt("WASMEDGE_AGENT_WEBSEARCH_TIMEOUT", DEFAULT_TIMEOUT_SECONDS),
		);
		const numResults = positiveIntOr(
			payload.num_results,
			envInt("WASMEDGE_AGENT_WEBSEARCH_NUM_RESULTS", DEFAULT_NUM_RESULTS),
		);
		const maxOutput = positiveIntOr(payload.max_output, DEFAULT_MAX_OUTPUT_CHARS);

		let result: string;
		try {
			result = await doFetch(query, apiKey, timeoutSeconds, numResults);
		} catch (error) {
			result = `Error searching for '${query}': ${error instanceof Error ? error.message : String(error)}`;
		}
		return { result: truncateMiddle(`Results for query "${query}":\n\n${result}`, maxOutput) };
	};
}
