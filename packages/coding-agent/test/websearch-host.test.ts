import { describe, expect, it } from "vitest";
import { createWebsearchHostHandler, formatSerperResults, truncateMiddle } from "../src/core/websearch-host.js";

describe("websearch.run host handler", () => {
	it("formats knowledge graph, organic results, and people-also-ask like the kernel-era skill", () => {
		const text = formatSerperResults(
			{
				knowledgeGraph: {
					title: "WasmEdge",
					description: "A lightweight WebAssembly runtime.",
					attributes: { License: "Apache-2.0", "": "  " },
				},
				organic: [
					{ title: "WasmEdge site", link: "https://wasmedge.org", snippet: "Fast wasm runtime." },
					{ title: "", link: "", snippet: "" },
					{ title: "Third", link: "https://example.com" },
				],
				peopleAlsoAsk: [
					{ question: "What is WasmEdge?", snippet: "A runtime." },
					{ question: "", snippet: "ignored" },
				],
			},
			"wasmedge",
			2,
		);
		expect(text).toContain("Knowledge Graph: WasmEdge");
		expect(text).toContain("License: Apache-2.0");
		expect(text).toContain("Result 0: WasmEdge site");
		expect(text).toContain("URL: https://wasmedge.org");
		expect(text).toContain("Result 1: Untitled");
		// num_results=2 cuts the third organic entry.
		expect(text).not.toContain("Third");
		expect(text).toContain("People Also Ask:\nQ: What is WasmEdge?\nA: A runtime.");
	});

	it("reports empty result sets", () => {
		expect(formatSerperResults({}, "nothing", 5)).toBe("No results returned for query: nothing");
	});

	it("truncates from the middle with a size marker", () => {
		const output = truncateMiddle("a".repeat(200), 100);
		expect(output.length).toBeLessThanOrEqual(100);
		expect(output).toContain("[output truncated, 200 chars total]");
	});

	it("returns setup instructions when no key resolves, without calling the API", async () => {
		let called = false;
		const handler = createWebsearchHostHandler({
			resolveApiKey: () => undefined,
			fetchImpl: async () => {
				called = true;
				return "unreachable";
			},
		});
		const reply = await handler({ query: "anything" });
		expect(String(reply.result)).toContain("no Serper API key is configured");
		expect(called).toBe(false);
	});

	it("passes options through, wraps results, and surfaces fetch errors as text", async () => {
		const seen: unknown[] = [];
		const handler = createWebsearchHostHandler({
			resolveApiKey: () => "key-1",
			fetchImpl: async (query, apiKey, timeoutSeconds, numResults) => {
				seen.push([query, apiKey, timeoutSeconds, numResults]);
				if (query === "boom") throw new Error("Serper search error (500): nope");
				return "RESULTS";
			},
		});

		const ok = await handler({ query: "rust wasi", timeout: 9, num_results: 3 });
		expect(ok.result).toBe('Results for query "rust wasi":\n\nRESULTS');
		expect(seen[0]).toEqual(["rust wasi", "key-1", 9, 3]);

		const failed = await handler({ query: "boom" });
		expect(String(failed.result)).toContain("Error searching for 'boom': Serper search error (500)");

		await expect(handler({ query: "  " })).rejects.toThrow("non-empty query");
	});
});
