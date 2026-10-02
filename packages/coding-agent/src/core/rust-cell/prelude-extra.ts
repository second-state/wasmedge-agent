import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PreludeExtra {
	name: string;
	/** Exact crates.io version, without a Cargo range operator. */
	version: string;
	features?: string[];
	defaultFeatures?: boolean;
}

const RESERVED = new Set(
	(
		"rlm agent_lib cell anyhow regex serde serde_json walkdir std core alloc proc_macro " +
		"as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref " +
		"return self static struct super trait true type unsafe use where while async await dyn abstract become box " +
		"do final macro override priv typeof unsized virtual yield try gen"
	).split(" "),
);

/** Validate before provisioning, and canonicalize order for workspace identity. */
export function normalizePreludeExtra(value: unknown): PreludeExtra[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("rustCell.preludeExtra must be an array");
	const names = new Set<string>();
	return value
		.map((entry: unknown): PreludeExtra => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error("rustCell.preludeExtra entries must be objects");
			}
			const item = entry as Record<string, unknown>;
			if (Object.keys(item).some((key) => !["name", "version", "features", "defaultFeatures"].includes(key))) {
				throw new Error("rustCell.preludeExtra supports only name, version, features and defaultFeatures");
			}
			if (typeof item.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.name)) {
				throw new Error("rustCell.preludeExtra requires a lowercase crate name (maximum 64 characters)");
			}
			const name = item.name.replaceAll("-", "_");
			if (RESERVED.has(name) || names.has(name)) {
				throw new Error(`rustCell.preludeExtra has a reserved or duplicate crate name: ${item.name}`);
			}
			names.add(name);
			if (typeof item.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.version)) {
				throw new Error(`rustCell.preludeExtra requires an exact x.y.z version: ${item.name}`);
			}
			if (item.defaultFeatures !== undefined && typeof item.defaultFeatures !== "boolean") {
				throw new Error(`rustCell.preludeExtra defaultFeatures must be a boolean: ${item.name}`);
			}
			if (
				item.features !== undefined &&
				(!Array.isArray(item.features) ||
					!item.features.every(
						(feature: unknown) => typeof feature === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(feature),
					))
			) {
				throw new Error(`rustCell.preludeExtra features must be crate feature names: ${item.name}`);
			}
			return {
				name: item.name,
				version: item.version,
				features: [...new Set((item.features ?? []) as string[])].sort(),
				defaultFeatures: item.defaultFeatures ?? true,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Called only on the staged scaffold, before mounting skills. The shared
 * template and the active workspace never receive partial dependency edits. */
export function writePreludeExtra(workspace: string, extras: PreludeExtra[]): void {
	const exports = extras.map(({ name }) => `pub use ::${name.replaceAll("-", "_")};`).join("\n");
	writeFileSync(
		join(workspace, "agent_lib/src/prelude_extra.rs"),
		`//! Additional crates. Managed by the host.\n${exports}\n`,
	);
	if (extras.length === 0) return;
	// Scaffold upgrades preserve user-edited library roots and preludes. Add the
	// new module's declarations without replacing those retained source files.
	for (const [path, declaration, pattern] of [
		["lib.rs", "pub mod prelude_extra;", /^\s*pub\s+mod\s+prelude_extra\s*;/m],
		[
			"prelude.rs",
			"pub use crate::prelude_extra as extra;",
			/^\s*pub\s+use\s+crate::prelude_extra\s+as\s+extra\s*;/m,
		],
	] as const) {
		const destination = join(workspace, "agent_lib/src", path);
		const source = readFileSync(destination, "utf-8");
		if (!pattern.test(source)) writeFileSync(destination, `${source}\n${declaration}\n`);
	}
	const dependencies = extras
		.map(
			({ name, version, features, defaultFeatures }) =>
				`${name} = { version = "=${version}", default-features = ${defaultFeatures}, features = ${JSON.stringify(features)} }`,
		)
		.join("\n");
	for (const [path, table, lines] of [
		["Cargo.toml", "[workspace.dependencies]", dependencies],
		["agent_lib/Cargo.toml", "[dependencies]", extras.map(({ name }) => `${name} = { workspace = true }`).join("\n")],
	]) {
		const destination = join(workspace, path);
		const manifest = readFileSync(destination, "utf-8");
		if (!manifest.includes(`${table}\n`)) throw new Error(`Missing ${table} in ${path}`);
		writeFileSync(destination, manifest.replace(`${table}\n`, `${table}\n${lines}\n`));
	}
}

export function preludeConfigurationHash(extras: PreludeExtra[]): string | undefined {
	return extras.length ? createHash("sha256").update(JSON.stringify(extras)).digest("hex") : undefined;
}

export function configurePreludeExtra(workspace: string, extras: PreludeExtra[], cargoBin: string): void {
	writePreludeExtra(workspace, extras);
	if (!extras.length) return;
	// cargo vendor ignores source replacement by default, resolving new crates
	// from crates.io while leaving the template's offline redirect intact.
	execFileSync(cargoBin, ["vendor", "vendor"], { cwd: workspace, stdio: "pipe", timeout: 300_000 });
}
