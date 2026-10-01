import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { getProjectConfigDir } from "../config.js";
import type { HostRequestHandler } from "./host-bridge/types.js";

const WORKSPACE_DEPENDENCIES = ["rlm", "anyhow", "regex", "serde", "serde_json", "walkdir"];
const RESERVED_CRATE_NAMES = new Set([
	...WORKSPACE_DEPENDENCIES,
	"agent_lib",
	"cell",
	"std",
	"core",
	"alloc",
	"proc_macro",
	"as",
	"break",
	"const",
	"continue",
	"crate",
	"else",
	"enum",
	"extern",
	"false",
	"fn",
	"for",
	"if",
	"impl",
	"in",
	"let",
	"loop",
	"match",
	"mod",
	"move",
	"mut",
	"pub",
	"ref",
	"return",
	"self",
	"static",
	"struct",
	"super",
	"trait",
	"true",
	"type",
	"unsafe",
	"use",
	"where",
	"while",
	"async",
	"await",
	"dyn",
	"abstract",
	"become",
	"box",
	"do",
	"final",
	"macro",
	"override",
	"priv",
	"typeof",
	"unsized",
	"virtual",
	"yield",
	"try",
	"gen",
]);
// cellSourceCode is host-owned metadata injected by BridgeServer.
const FIELDS = new Set(["name", "description", "instructions", "source", "cellSourceCode"]);

function requiredText(payload: Record<string, unknown>, key: string, maxLength: number): string {
	const value = payload[key];
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
		throw new Error(`skills.package requires non-empty ${key} (maximum ${maxLength} characters)`);
	}
	return value;
}

/** Create parents one component at a time so existing symlinks are never followed. */
function ensureSkillRoot(cwd: string): string {
	const root = realpathSync(cwd);
	const skills = join(getProjectConfigDir(root), "skills");
	const path = relative(root, skills);
	if (!path || isAbsolute(path) || path.split(sep).includes("..")) {
		throw new Error("project skills directory must be inside the project");
	}
	let current = root;
	for (const part of path.split(sep)) {
		current = join(current, part);
		try {
			mkdirSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (!lstatSync(current).isDirectory()) {
			throw new Error(`skills.package requires a directory without symlinks: ${current}`);
		}
	}
	return skills;
}

export function createSkillPackageHostHandler(options: {
	cwd: string;
	existingNames: () => readonly string[];
}): HostRequestHandler {
	return async (payload, context) => {
		context?.signal.throwIfAborted();
		for (const field of Object.keys(payload)) {
			if (!FIELDS.has(field)) throw new Error(`unknown skills.package field: ${field}`);
		}
		const name = requiredText(payload, "name", 64);
		if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
			throw new Error(
				"skill name must start with a lowercase letter and contain lowercase letters, digits or single hyphens",
			);
		}
		const crateName = name.replaceAll("-", "_");
		if (RESERVED_CRATE_NAMES.has(crateName)) throw new Error(`reserved skill crate name: ${crateName}`);
		if (options.existingNames().some((existing) => existing.replaceAll("-", "_") === crateName)) {
			throw new Error(`skill already loaded: ${name}`);
		}
		const description = requiredText(payload, "description", 1024);
		const instructions = requiredText(payload, "instructions", 64 * 1024);
		const source = requiredText(payload, "source", 256 * 1024);
		const manifest = `[package]\nname = "${crateName}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n${WORKSPACE_DEPENDENCIES.map((dependency) => `${dependency} = { workspace = true }`).join("\n")}\n`;
		const skillDoc = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`;
		const directory = join(ensureSkillRoot(options.cwd), name);
		// Exclusive creation also rejects files, empty directories and dangling symlinks.
		mkdirSync(directory);
		try {
			mkdirSync(join(directory, "src"));
			writeFileSync(join(directory, "Cargo.toml"), manifest, { flag: "wx" });
			writeFileSync(join(directory, "src", "lib.rs"), source, { flag: "wx" });
			// Discovery should only see a skill after both crate files exist.
			writeFileSync(join(directory, "SKILL.md"), skillDoc, { flag: "wx" });
		} catch (error) {
			rmSync(directory, { recursive: true, force: true });
			throw error;
		}
		return {
			path: `/workspace/${relative(realpathSync(options.cwd), directory).split(sep).join("/")}`,
			crate_name: crateName,
			rust_use: `agent_lib::skills::${crateName}`,
			requires_reload: true,
		};
	};
}
