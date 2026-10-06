#!/usr/bin/env node
// Bundled catalog assets. The model and MCP service catalogs ship in-tree under
// catalog/ and are copied into dist at build time; nothing is fetched.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const bundledCatalogFiles = ["models.bundled.json", "mcp-services.bundled.json"];
export const MIN_BUNDLED_MODEL_TRANSPORT_TUPLES = 42;
export const MIN_BUNDLED_MCP_SERVICES = 20;

function catalogSourcePaths(catalogDir) {
	return {
		models: join(catalogDir, "models", "catalog.v1.json"),
		mcpServices: join(catalogDir, "plugins", "catalog.v2.json"),
	};
}

function bundledTargets(outDir) {
	return {
		models: join(outDir, "models.bundled.json"),
		mcpServices: join(outDir, "mcp-services.bundled.json"),
	};
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

const MODEL_REQUIRED_KEYS = ["id", "name", "api", "provider", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens"];
const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
const MCP_REQUIRED_KEYS = ["server", "service", "label", "url", "aliases", "transport", "auth", "setup", "verification", "legacyBuiltin", "provenance"];

/**
 * Per-entry structural checks mirroring the runtime parsers' required fields, so a
 * malformed bundled asset fails the build here instead of being silently rejected
 * by parseModelCatalog/parseMcpServiceCatalogFile at runtime (which would drop the
 * user to the compiled fallback).
 */
export function validateBundledModelCatalog(path, options = {}) {
	const catalog = readJson(path);
	if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.models)) throw new Error(`Invalid bundled model catalog: ${path}`);
	const tuples = new Set();
	const seen = new Set();
	for (const [index, model] of catalog.models.entries()) {
		if (!model || typeof model !== "object") throw new Error(`Bundled model catalog entry ${index} is not an object: ${path}`);
		for (const key of MODEL_REQUIRED_KEYS) {
			if (!(key in model)) throw new Error(`Bundled model catalog entry ${index} is missing required key ${key}: ${path}`);
		}
		for (const key of ["id", "name", "api", "provider"]) {
			if (typeof model[key] !== "string" || model[key] === "") {
				throw new Error(`Bundled model catalog entry ${index} has an invalid ${key}: ${path}`);
			}
		}
		if (typeof model.baseUrl !== "string") {
			throw new Error(`Bundled model catalog entry ${index} has a non-string baseUrl: ${path}`);
		}
		if (typeof model.reasoning !== "boolean") {
			throw new Error(`Bundled model catalog entry ${index} has a non-boolean reasoning: ${path}`);
		}
		if (!Array.isArray(model.input) || model.input.length === 0 || !model.input.every((item) => item === "text" || item === "image")) {
			throw new Error(`Bundled model catalog entry ${index} has invalid input modalities: ${path}`);
		}
		if (!model.cost || typeof model.cost !== "object") {
			throw new Error(`Bundled model catalog entry ${index} has a non-object cost: ${path}`);
		}
		for (const key of MODEL_COST_KEYS) {
			if (typeof model.cost[key] !== "number" || !Number.isFinite(model.cost[key]) || model.cost[key] < 0) {
				throw new Error(`Bundled model catalog entry ${index} has an invalid cost.${key}: ${path}`);
			}
		}
		if (typeof model.contextWindow !== "number" || !Number.isInteger(model.contextWindow) || model.contextWindow < 1) {
			throw new Error(`Bundled model catalog entry ${index} has an invalid contextWindow: ${path}`);
		}
		if (typeof model.maxTokens !== "number" || !Number.isInteger(model.maxTokens) || model.maxTokens < 1) {
			throw new Error(`Bundled model catalog entry ${index} has an invalid maxTokens: ${path}`);
		}
		const key = `${model.provider}\u0000${model.id}`;
		if (seen.has(key)) throw new Error(`Bundled model catalog has duplicate provider/id ${key}: ${path}`);
		seen.add(key);
		if (tuples.size < 10_000) tuples.add(JSON.stringify([model.provider, model.api, model.baseUrl]));
	}
	if (!options.allowSmallFixture && tuples.size < MIN_BUNDLED_MODEL_TRANSPORT_TUPLES) {
		throw new Error(`Bundled model catalog has ${tuples.size} transport tuples; expected at least ${MIN_BUNDLED_MODEL_TRANSPORT_TUPLES}`);
	}
	return { models: catalog.models.length, transportTuples: tuples.size };
}

export function validateBundledMcpCatalog(path, options = {}) {
	const catalog = readJson(path);
	if (catalog?.version !== 2 || !Array.isArray(catalog.entries)) throw new Error(`Invalid bundled MCP service catalog: ${path}`);
	const seen = new Set();
	for (const [index, entry] of catalog.entries.entries()) {
		if (!entry || typeof entry !== "object") throw new Error(`Bundled MCP service catalog entry ${index} is not an object: ${path}`);
		for (const key of MCP_REQUIRED_KEYS) {
			if (!(key in entry)) throw new Error(`Bundled MCP service catalog entry ${index} is missing required key ${key}: ${path}`);
		}
		for (const key of ["server", "service", "label"]) {
			if (typeof entry[key] !== "string" || entry[key] === "") {
				throw new Error(`Bundled MCP service catalog entry ${index} has an invalid ${key}: ${path}`);
			}
		}
		// The runtime catalog allows an empty url for stdio and http-template transports.
		if (typeof entry.url !== "string" || (entry.url === "" && entry.transport.type !== "stdio" && entry.transport.type !== "http-template")) {
			throw new Error(`Bundled MCP service catalog entry ${index} has an invalid url: ${path}`);
		}
		if (!Array.isArray(entry.aliases) || !entry.aliases.every((alias) => typeof alias === "string")) {
			throw new Error(`Bundled MCP service catalog entry ${index} has invalid aliases: ${path}`);
		}
		if (!entry.transport || typeof entry.transport !== "object" || typeof entry.transport.type !== "string") {
			throw new Error(`Bundled MCP service catalog entry ${index} has an invalid transport: ${path}`);
		}
		if (!entry.auth || typeof entry.auth !== "object" || typeof entry.auth.strategy !== "string") {
			throw new Error(`Bundled MCP service catalog entry ${index} has an invalid auth: ${path}`);
		}
		if (!entry.setup || typeof entry.setup !== "object" || typeof entry.setup.status !== "string") {
			throw new Error(`Bundled MCP service catalog entry ${index} has an invalid setup: ${path}`);
		}
		if (!entry.verification || typeof entry.verification !== "object" || typeof entry.verification.status !== "string") {
			throw new Error(`Bundled MCP service catalog entry ${index} has an invalid verification: ${path}`);
		}
		if (typeof entry.legacyBuiltin !== "boolean") {
			throw new Error(`Bundled MCP service catalog entry ${index} has a non-boolean legacyBuiltin: ${path}`);
		}
		if (!Array.isArray(entry.provenance) || entry.provenance.length === 0) {
			throw new Error(`Bundled MCP service catalog entry ${index} has invalid provenance: ${path}`);
		}
		if (seen.has(entry.server)) throw new Error(`Bundled MCP service catalog has duplicate server id ${entry.server}: ${path}`);
		seen.add(entry.server);
	}
	if (!options.allowSmallFixture && catalog.entries.length < MIN_BUNDLED_MCP_SERVICES) {
		throw new Error(`Bundled MCP service catalog has ${catalog.entries.length} entries; expected at least ${MIN_BUNDLED_MCP_SERVICES}`);
	}
	return { services: catalog.entries.length };
}

export function validateBundledCatalogDir(directory, options = {}) {
	return {
		models: validateBundledModelCatalog(join(directory, "models.bundled.json"), options),
		mcpServices: validateBundledMcpCatalog(join(directory, "mcp-services.bundled.json"), options),
	};
}

/** Refresh the in-tree bundled assets from a local catalog checkout (models/catalog.v1.json, plugins/catalog.v2.json). */
export function generateBundledCatalogAssets(options = {}) {
	if (!options.catalogDir) throw new Error("generate requires --catalog-dir DIR");
	const outDir = resolve(options.outDir ?? join(packageDir, "catalog"));
	mkdirSync(outDir, { recursive: true });
	const paths = catalogSourcePaths(resolve(options.catalogDir));
	const targets = bundledTargets(outDir);
	cpSync(paths.models, targets.models);
	cpSync(paths.mcpServices, targets.mcpServices);
	return validateBundledCatalogDir(outDir, options);
}

/** Copy the committed catalog/ assets into the build output. */
export function copySourceCatalogAssets(options = {}) {
	const outDir = resolve(options.outDir ?? join(packageDir, "dist"));
	const sourceDir = resolve(options.sourceDir ?? join(packageDir, "catalog"));
	const missing = bundledCatalogFiles.filter((file) => !existsSync(join(sourceDir, file)));
	if (missing.length > 0) throw new Error(`Missing bundled catalog assets in ${sourceDir}: ${missing.join(", ")}`);
	mkdirSync(outDir, { recursive: true });
	for (const file of bundledCatalogFiles) cpSync(join(sourceDir, file), join(outDir, file));
	return validateBundledCatalogDir(outDir, options);
}

function parseArgs(argv) {
	let [command, ...rest] = argv;
	if (!command || command.startsWith("--")) {
		command = "copy-source";
		rest = argv;
	}
	const options = {};
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === "--out") options.outDir = rest[++i];
		else if (arg === "--catalog-dir") options.catalogDir = rest[++i];
		else if (arg === "--allow-small-fixture") options.allowSmallFixture = true;
		else throw new Error(`Unknown catalog-assets argument: ${arg}`);
	}
	return { command, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { command, options } = parseArgs(process.argv.slice(2));
	const result =
		command === "generate"
			? generateBundledCatalogAssets(options)
			: command === "copy-source"
				? copySourceCatalogAssets(options)
				: command === "verify"
					? validateBundledCatalogDir(resolve(options.outDir ?? join(packageDir, "dist")), options)
					: undefined;
	if (!result) throw new Error("Usage: catalog-assets.mjs [copy-source|generate|verify] [--out DIR] [--catalog-dir DIR]");
	console.log(JSON.stringify(result, null, 2));
}
