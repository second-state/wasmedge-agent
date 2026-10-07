import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CargoSandbox } from "./cargo-sandbox.js";
import { objectValue, RUSTDOC_FORMAT_VERSION, type RustdocApiItem } from "./rustdoc-index.js";
import {
	skillSourceFingerprint,
	skillSourceFingerprintAsync,
	skillTestFingerprint,
	skillTestFingerprintAsync,
} from "./skill-fingerprint.js";

export const RUSTDOC_CACHE_PATH = "target/.agent-api.json";
export const MAX_RUSTDOC_BYTES = 32 * 1024 * 1024;

export interface RustdocCache {
	cargoSandbox?: CargoSandbox;
	schema: 1;
	formatVersion: number;
	target: "wasm32-wasip1";
	toolchain: string;
	rustcVersion: string;
	fingerprint: string;
	items: RustdocApiItem[];
}

export function normalizeRustdocToolchain(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value)) return value;
	throw new Error("rustCell.rustdocToolchain must be an installed rustup toolchain name or null");
}

export function rustdocFingerprint(workspace: string, mountedSkills: string[]): string {
	return createHash("sha256")
		.update(skillTestFingerprint(workspace, mountedSkills))
		.update(skillSourceFingerprint(workspace, ["cell/Cargo.toml"]))
		.digest("hex");
}

export async function rustdocFingerprintAsync(
	workspace: string,
	mountedSkills: string[],
	signal?: AbortSignal,
): Promise<string> {
	return createHash("sha256")
		.update(await skillTestFingerprintAsync(workspace, mountedSkills, signal))
		.update(await skillSourceFingerprintAsync(workspace, ["cell/Cargo.toml"], signal))
		.digest("hex");
}

export function readRustdocJson(path: string): unknown {
	const stat = statSync(path);
	if (!stat.isFile() || stat.size > MAX_RUSTDOC_BYTES) throw new Error("Rustdoc JSON exceeds the 32 MiB file limit");
	const content = readFileSync(path);
	if (content.byteLength > MAX_RUSTDOC_BYTES) throw new Error("Rustdoc JSON exceeds the 32 MiB file limit");
	return JSON.parse(content.toString("utf8"));
}

export async function readRustdocJsonAsync(path: string, signal?: AbortSignal): Promise<unknown> {
	signal?.throwIfAborted();
	const entry = await stat(path);
	signal?.throwIfAborted();
	if (!entry.isFile() || entry.size > MAX_RUSTDOC_BYTES) throw new Error("Rustdoc JSON exceeds the 32 MiB file limit");
	const content = await readFile(path, { signal });
	signal?.throwIfAborted();
	if (content.byteLength > MAX_RUSTDOC_BYTES) throw new Error("Rustdoc JSON exceeds the 32 MiB file limit");
	return JSON.parse(content.toString("utf8"));
}

function parseRustdocCache(content: unknown): RustdocCache | undefined {
	const data = objectValue(content);
	if (
		data.schema !== 1 ||
		data.formatVersion !== RUSTDOC_FORMAT_VERSION ||
		data.target !== "wasm32-wasip1" ||
		typeof data.toolchain !== "string" ||
		typeof data.rustcVersion !== "string" ||
		typeof data.fingerprint !== "string" ||
		!Array.isArray(data.items) ||
		data.items.length > 20_000
	)
		return undefined;
	for (const raw of data.items) {
		const item = objectValue(raw);
		if (
			typeof item.path !== "string" ||
			typeof item.kind !== "string" ||
			(item.docs !== null && typeof item.docs !== "string")
		)
			return undefined;
		objectValue(item.declaration);
	}
	return data as unknown as RustdocCache;
}

/** Reading a notice must neither provision a runtime nor execute Cargo. */
export function readRustdocCache(workspace: string, mountedSkills: string[]): RustdocCache | undefined {
	try {
		const cache = parseRustdocCache(readRustdocJson(join(workspace, RUSTDOC_CACHE_PATH)));
		return cache && cache.fingerprint === rustdocFingerprint(workspace, mountedSkills) ? cache : undefined;
	} catch {
		return undefined;
	}
}

export async function readRustdocCacheAsync(
	workspace: string,
	mountedSkills: string[],
	signal?: AbortSignal,
): Promise<RustdocCache | undefined> {
	try {
		const cache = parseRustdocCache(await readRustdocJsonAsync(join(workspace, RUSTDOC_CACHE_PATH), signal));
		if (!cache) return undefined;
		const fingerprint = await rustdocFingerprintAsync(workspace, mountedSkills, signal);
		signal?.throwIfAborted();
		return cache.fingerprint === fingerprint ? cache : undefined;
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}
