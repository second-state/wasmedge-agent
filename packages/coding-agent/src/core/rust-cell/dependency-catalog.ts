import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePreludeExtra, type PreludeExtra } from "./prelude-extra.js";

// Exact crates.io releases with default features, exercised by the WASI catalog
// integration test. The model selects names, never versions, features or sources.
export const CURATED_DEPENDENCIES = Object.freeze({
	"aho-corasick": "1.1.5",
	arrayvec: "0.7.8",
	base64: "0.22.1",
	byteorder: "1.5.0",
	bytes: "1.12.1",
	csv: "1.4.0",
	"csv-core": "0.1.13",
	"data-encoding": "2.11.1",
	either: "1.18.0",
	glob: "0.3.4",
	hex: "0.4.3",
	humantime: "2.4.0",
	indexmap: "2.14.2",
	itertools: "0.15.0",
	itoa: "1.0.18",
	memchr: "2.8.3",
	once_cell: "1.21.4",
	"ordered-float": "5.5.0",
	"percent-encoding": "2.3.2",
	"regex-automata": "0.4.18",
	"regex-syntax": "0.8.11",
	semver: "1.0.28",
	sha2: "0.11.0",
	smallvec: "1.16.2",
	strsim: "0.11.1",
	"unicode-ident": "1.0.26",
	"unicode-normalization": "0.1.25",
	"unicode-segmentation": "1.13.3",
	"unicode-width": "0.2.2",
	urlencoding: "2.1.3",
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
