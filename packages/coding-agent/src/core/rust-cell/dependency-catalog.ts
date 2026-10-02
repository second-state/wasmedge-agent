import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePreludeExtra, type PreludeExtra } from "./prelude-extra.js";

// These exact versions are already vendored by the template. Adding them never
// fetches code or accepts model-selected versions, features, or build scripts.
export const CURATED_DEPENDENCIES = Object.freeze({
	"aho-corasick": "1.1.5",
	base64: "0.22.1",
	itoa: "1.0.18",
	memchr: "2.8.3",
	"regex-automata": "0.4.18",
	"regex-syntax": "0.8.11",
});
export const CELL_DEPENDENCIES_FILE = ".cell-dependencies.json";

export function curatedDependency(name: unknown): PreludeExtra {
	if (typeof name !== "string" || !Object.hasOwn(CURATED_DEPENDENCIES, name)) {
		throw new Error(`deps.add requires a curated crate name: ${Object.keys(CURATED_DEPENDENCIES).join(", ")}`);
	}
	return { name, version: CURATED_DEPENDENCIES[name as keyof typeof CURATED_DEPENDENCIES] };
}

export function readCellDependencies(workspace: string): string[] {
	const path = join(workspace, CELL_DEPENDENCIES_FILE);
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return [];
	if (!stat.isFile()) throw new Error(`Expected a regular dependency record: ${path}`);
	const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (!Array.isArray(value)) throw new Error(`Invalid dependency record: ${path}`);
	return [...new Set(value.map((name: unknown) => curatedDependency(name).name))].sort();
}

export function workspaceDependencies(configured: PreludeExtra[], added: string[]): PreludeExtra[] {
	const names = new Set(configured.map(({ name }) => name.replaceAll("-", "_")));
	return normalizePreludeExtra([
		...configured,
		...added.map(curatedDependency).filter(({ name }) => !names.has(name.replaceAll("-", "_"))),
	]);
}
