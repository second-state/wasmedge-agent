import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	copySourceCatalogAssets,
	generateBundledCatalogAssets,
	validateBundledCatalogDir,
} from "../scripts/catalog-assets.mjs";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "catalog-assets-"));
	tempDirs.push(dir);
	return dir;
}

const sourceCatalogDir = join(process.cwd(), "catalog");

describe("bundled catalog assets", () => {
	it("ships valid in-tree catalogs that meet the release minimums", () => {
		const result = validateBundledCatalogDir(sourceCatalogDir);
		expect(result.models.models).toBeGreaterThan(0);
		expect(result.mcpServices.services).toBeGreaterThan(0);
	});

	it("copies the in-tree assets into the build output byte-for-byte", () => {
		const outDir = tempDir();
		copySourceCatalogAssets({ outDir });
		for (const file of ["models.bundled.json", "mcp-services.bundled.json"]) {
			expect(readFileSync(join(outDir, file), "utf8")).toBe(readFileSync(join(sourceCatalogDir, file), "utf8"));
		}
	});

	it("fails the build when a bundled asset is missing", () => {
		const sourceDir = tempDir();
		writeFileSync(
			join(sourceDir, "models.bundled.json"),
			readFileSync(join(sourceCatalogDir, "models.bundled.json")),
		);
		expect(() => copySourceCatalogAssets({ outDir: tempDir(), sourceDir })).toThrow(/mcp-services\.bundled\.json/);
	});

	it("refreshes assets from a local catalog checkout and validates them", () => {
		const checkout = tempDir();
		mkdirSync(join(checkout, "models"));
		mkdirSync(join(checkout, "plugins"));
		writeFileSync(join(checkout, "models", "catalog.v1.json"), JSON.stringify({ schemaVersion: 1, models: [] }));
		writeFileSync(
			join(checkout, "plugins", "catalog.v2.json"),
			readFileSync(join(sourceCatalogDir, "mcp-services.bundled.json")),
		);
		expect(() => generateBundledCatalogAssets({ outDir: tempDir() })).toThrow(/--catalog-dir/);
		// An empty model list is accepted structurally but fails the transport minimum.
		expect(() => generateBundledCatalogAssets({ outDir: tempDir(), catalogDir: checkout })).toThrow(
			/transport tuples/,
		);
	});
});
