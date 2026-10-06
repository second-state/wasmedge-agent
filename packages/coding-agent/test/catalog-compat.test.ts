import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelCatalog, parseModelCatalog } from "@earendil-works/pi-ai";
import { parseMcpServiceCatalogFile } from "@earendil-works/pi-ai/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { getBundledModels } from "../src/core/bundled-model-catalog.js";
import { resolveServiceCatalogWithDiagnostics } from "../src/core/mcp/service-catalog.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { PRIME_INFERENCE_BASE_URL } from "../src/core/prime-inference-model-catalog.js";
import { parseProviderModelCatalog } from "../src/core/provider-model-catalog.js";

const catalogDir = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog");

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("bundled catalog compatibility", () => {
	it("serves every supported model from the in-tree bundled catalog", () => {
		const bundled = getBundledModels();
		const shipped = parseProviderModelCatalog(
			JSON.parse(readFileSync(join(catalogDir, "models.bundled.json"), "utf8")),
			bundled,
		);
		const keys = new Set(bundled.map((model) => `${model.provider}/${model.id}`));
		expect(shipped.length).toBeGreaterThan(100);
		for (const model of shipped) expect(keys.has(`${model.provider}/${model.id}`)).toBe(true);
	});

	it("drops one malformed model from a provider catalog while keeping valid entries", () => {
		const bundled = getBundledModels();
		const valid = createModelCatalog(
			bundled.filter((model) => model.provider !== "prime-inference").slice(0, 2),
		).models;
		const malformed = { ...valid[0], id: "broken-entry", contextWindow: 0 };
		const parsed = parseProviderModelCatalog({ schemaVersion: 1, models: [valid[0], malformed, valid[1]] }, bundled);

		expect(parsed.map((model) => model.id)).toEqual(valid.map((model) => model.id));
		expect(() => parseModelCatalog({ schemaVersion: 1, models: [valid[0], malformed, valid[1]] })).toThrow(
			"Invalid model catalog entry",
		);
	});

	it("resolves MCP services from the bundled catalog without diagnostics", () => {
		const shipped = parseMcpServiceCatalogFile(
			JSON.parse(readFileSync(join(catalogDir, "mcp-services.bundled.json"), "utf8")),
		).entries;
		const resolution = resolveServiceCatalogWithDiagnostics([], []);
		const ids = new Set(resolution.descriptors.map((descriptor) => descriptor.serviceId));
		expect(resolution.diagnostics).toEqual([]);
		for (const entry of shipped) expect(ids.has(entry.server)).toBe(true);
	});

	it("refreshes models without fetching any catalog beyond the Prime Inference API", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.startsWith(PRIME_INFERENCE_BASE_URL)) return new Response("unavailable", { status: 503 });
			throw new Error(`unexpected fetch ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const before = registry.getAll().length;

		await registry.refreshModelCatalog();
		await registry.waitForPendingModelRefreshes(2_000);

		expect(registry.getAll().length).toBe(before);
		for (const [input] of fetchMock.mock.calls) {
			const url = input instanceof Request ? input.url : input.toString();
			expect(url.startsWith(PRIME_INFERENCE_BASE_URL)).toBe(true);
		}
	});
});
