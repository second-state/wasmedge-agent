import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SourceInput {
	path: string;
	realPath: string;
	hash: string;
}

type Group = "A" | "B" | "F";

/** Canonical recorded evidence only: analysis must not read today's source tree. */
export function sourceInputsIdentity(value: unknown): string | null {
	if (!Array.isArray(value) || !value.length) return null;
	const inputs: SourceInput[] = [];
	for (const input of value) {
		if (!input || typeof input !== "object" || Array.isArray(input) ||
			Object.keys(input).sort().join(",") !== "hash,path,realPath" ||
			![input.path, input.realPath].every((path) =>
				typeof path === "string" && !path.includes("\0") && isAbsolute(path) && resolve(path) === path) ||
			typeof input.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.hash)) return null;
		inputs.push({ path: input.path, realPath: input.realPath, hash: input.hash });
	}
	if (new Set(inputs.map((input) => input.path)).size !== inputs.length ||
		new Set(inputs.map((input) => input.realPath)).size !== inputs.length) return null;
	return JSON.stringify(inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function sourceInputsHash(value: unknown): string | null {
	const identity = sourceInputsIdentity(value);
	return identity === null ? null : `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export function sameSourceInputs(a: unknown, b: unknown): boolean {
	if (a === undefined || a === null || b === undefined || b === null) return a === b;
	const identity = sourceInputsIdentity(a);
	return identity !== null && identity === sourceInputsIdentity(b);
}

function inspectSourceInput(path: string): SourceInput {
	const realPath = realpathSync(path);
	const hash = createHash("sha256");
	const visit = (file: string, name: string) => {
		const info = lstatSync(file);
		if (info.isDirectory()) {
			hash.update(JSON.stringify(["directory", name]));
			for (const child of readdirSync(file).sort()) visit(join(file, child), name ? `${name}/${child}` : child);
		} else if (info.isFile()) {
			const bytes = readFileSync(file);
			hash.update(JSON.stringify(["file", name, info.mode & 0o111, bytes.length]));
			hash.update(bytes);
		} else {
			throw new Error(`benchmark source inputs must contain only regular files and directories: ${file}`);
		}
	};
	visit(realPath, "");
	return { path, realPath, hash: `sha256:${hash.digest("hex")}` };
}

function contains(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function loadSourceInputs(path: string | null, groups: Group[], resultsDir: string): Map<Group, SourceInput[] | null> {
	if (path === null) return new Map(groups.map((group) => [group, null]));
	const manifestPath = resolve(path);
	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
	} catch {
		throw new Error("invalid or unreadable benchmark source-input manifest");
	}
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
		Object.keys(manifest).some((key) => !["A", "B", "F"].includes(key))) {
		throw new Error("benchmark source-input manifest must map A/B/F to nonempty path arrays");
	}
	const declared = manifest as Record<string, unknown>;
	for (const [group, paths] of Object.entries(declared)) {
		if (!Array.isArray(paths) || !paths.length || paths.some((input) =>
			typeof input !== "string" || !input.trim() || input.includes("\0"))) {
			throw new Error(`invalid benchmark source-input paths for group ${group}`);
		}
	}
	// lockPlan creates results/locks before planning, so its real path exists here.
	const resultsRealPath = realpathSync(resultsDir);
	return new Map(groups.map((group) => {
		if (!(group in declared)) throw new Error(`benchmark source-input manifest is missing group ${group}`);
		const inputs = (declared[group] as string[]).map((input) => {
			const absolute = resolve(dirname(manifestPath), input);
			const realPath = realpathSync(absolute);
			if (contains(realPath, resultsRealPath) || contains(resultsRealPath, realPath)) {
				throw new Error(`benchmark source input overlaps the results directory: ${absolute}`);
			}
			return inspectSourceInput(absolute);
		});
		if (!sourceInputsIdentity(inputs)) throw new Error(`duplicate benchmark source-input paths for group ${group}`);
		return [group, inputs];
	}));
}

export function verifySourceInputs(inputs: SourceInput[] | null | undefined): void {
	if (inputs === null || inputs === undefined) return;
	try {
		const identity = sourceInputsIdentity(inputs);
		if (identity && sourceInputsIdentity(inputs.map((input) => inspectSourceInput(input.path))) === identity) return;
	} catch {
		// Missing/unreadable files or unsupported entries also invalidate the pin.
	}
	throw new Error("benchmark source inputs changed or are unavailable");
}
