import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { objectValue, RUSTDOC_FORMAT_VERSION, type RustdocApiItem } from "./rustdoc-index.js";
import { skillSourceFingerprint, skillTestFingerprint } from "./skill-fingerprint.js";

export const RUSTDOC_CACHE_PATH = "target/.agent-api.json";
export const MAX_RUSTDOC_BYTES = 32 * 1024 * 1024;

export interface RustdocCache {
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

export function readRustdocJson(path: string): unknown {
	const stat = statSync(path);
	if (!stat.isFile() || stat.size > MAX_RUSTDOC_BYTES) throw new Error("Rustdoc JSON exceeds the 32 MiB file limit");
	const content = readFileSync(path);
	if (content.byteLength > MAX_RUSTDOC_BYTES) throw new Error("Rustdoc JSON exceeds the 32 MiB file limit");
	return JSON.parse(content.toString("utf8"));
}

/** Reading a notice must neither provision a runtime nor execute Cargo. */
export function readRustdocCache(workspace: string, mountedSkills: string[]): RustdocCache | undefined {
	try {
		const data = objectValue(readRustdocJson(join(workspace, RUSTDOC_CACHE_PATH)));
		if (
			data.schema !== 1 ||
			data.formatVersion !== RUSTDOC_FORMAT_VERSION ||
			data.target !== "wasm32-wasip1" ||
			typeof data.toolchain !== "string" ||
			typeof data.rustcVersion !== "string" ||
			data.fingerprint !== rustdocFingerprint(workspace, mountedSkills) ||
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
	} catch {
		return undefined;
	}
}
