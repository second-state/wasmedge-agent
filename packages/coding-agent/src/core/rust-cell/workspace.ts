/** Session workspace management: template clone, declarative lib-file
 * application with atomic revert (DESIGN.md D14), helpers/mod.rs
 * regeneration, and persistent-state listing for compaction/resume notices. */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LibFile } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Locate the guest workspace template: packaged dist copy first (copy-assets),
 * then the repo-root source (running from source). Mirrors the runtime-source
 * resolution the kernel bootstrap used. */
export function resolveTemplateDir(): string {
	const candidates = [
		resolve(HERE, "..", "..", "wasmedge-agent-runtime", "template"),
		resolve(HERE, "..", "..", "..", "wasmedge-agent-runtime", "template"),
		resolve(HERE, "..", "..", "..", "..", "wasmedge-agent-runtime", "template"),
	];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "Cargo.toml"))) return candidate;
	}
	throw new Error(`wasmedge-agent-runtime template not found (searched: ${candidates.join(", ")})`);
}

/** Clone the template into `dir` if it does not exist yet. clonefile on macOS
 * carries the warm target/ cache for ~free; plain copy elsewhere. */
export function ensureWorkspaceAt(dir: string): string {
	if (existsSync(join(dir, "Cargo.toml"))) return dir;
	mkdirSync(dirname(dir), { recursive: true });
	const template = resolveTemplateDir();
	const clone = spawnSync("cp", ["-Rc", template, dir], { encoding: "utf-8" });
	if (clone.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		execFileSync("cp", ["-R", template, dir]);
	}
	return dir;
}

export function removeWorkspace(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

export interface AppliedLib {
	/** Previous content per absolute path (null = file did not exist). */
	backups: Map<string, string | null>;
	modRsRegenerated: boolean;
}

function assertLibPath(workspaceDir: string, path: string): string {
	const clean = normalize(path);
	if (isAbsolute(clean) || clean.startsWith("..") || clean.includes("../")) {
		throw new Error(`lib path escapes agent_lib/: ${path}`);
	}
	if (!(clean === "src" || clean.startsWith("src/")) || !clean.endsWith(".rs")) {
		throw new Error(`lib path must be a .rs file under src/: ${path}`);
	}
	return join(workspaceDir, "agent_lib", clean);
}

/** Write declared lib files, remembering previous contents for revert. */
export function applyLib(workspaceDir: string, files: LibFile[]): AppliedLib {
	const backups = new Map<string, string | null>();
	for (const file of files) {
		const target = assertLibPath(workspaceDir, file.path);
		backups.set(target, existsSync(target) ? readFileSync(target, "utf-8") : null);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, file.content);
	}
	const modRsRegenerated = regenerateHelpersModRs(workspaceDir, files);
	return { backups, modRsRegenerated };
}

/** Restore all files touched by applyLib (delete files that did not exist). */
export function revertLib(workspaceDir: string, applied: AppliedLib): void {
	for (const [target, previous] of applied.backups) {
		if (previous === null) {
			rmSync(target, { force: true });
		} else {
			writeFileSync(target, previous);
		}
	}
	if (applied.modRsRegenerated) {
		regenerateHelpersModRs(workspaceDir, []);
	}
}

/** Keep src/helpers/mod.rs in sync with the .rs files present, unless the call
 * provided its own mod.rs (model-managed wins). Returns whether the host
 * (re)generated the file. */
function regenerateHelpersModRs(workspaceDir: string, declared: LibFile[]): boolean {
	if (declared.some((f) => normalize(f.path) === "src/helpers/mod.rs")) return false;
	const helpersDir = join(workspaceDir, "agent_lib", "src", "helpers");
	if (!existsSync(helpersDir)) return false;
	const modules = readdirSync(helpersDir)
		.filter((name) => name.endsWith(".rs") && name !== "mod.rs")
		.map((name) => name.slice(0, -3))
		.sort();
	const header =
		"//! Model-added helper modules. Managed by the host: when a `lib` tool\n" +
		"//! parameter adds `src/helpers/<name>.rs`, the host regenerates the `pub mod`\n" +
		"//! declarations below (unless the call provides its own mod.rs).\n";
	const body = modules.map((name) => `pub mod ${name};`).join("\n");
	writeFileSync(join(helpersDir, "mod.rs"), body ? `${header}\n${body}\n` : header);
	return true;
}

export interface PersistentStateListing {
	stateKeys: string[];
	blobNames: string[];
	libFunctions: string[];
}

/** Host-side view of guest-persistent state for compaction/resume notices
 * (DESIGN.md §2.8). Light regex scan; rustdoc JSON is the Phase 2 upgrade. */
export function listPersistentState(workspaceDir: string): PersistentStateListing {
	const listing: PersistentStateListing = { stateKeys: [], blobNames: [], libFunctions: [] };
	const statePath = join(workspaceDir, "state", "state.json");
	if (existsSync(statePath)) {
		try {
			listing.stateKeys = Object.keys(JSON.parse(readFileSync(statePath, "utf-8"))).sort();
		} catch {
			// unreadable state file: report no keys rather than failing the notice
		}
	}
	const blobsDir = join(workspaceDir, "state", "blobs");
	if (existsSync(blobsDir)) {
		listing.blobNames = readdirSync(blobsDir)
			.filter((name) => !name.endsWith(".tmp"))
			.sort();
	}
	const helpersDir = join(workspaceDir, "agent_lib", "src", "helpers");
	if (existsSync(helpersDir)) {
		const pubFn = /pub fn ([a-zA-Z0-9_]+)\s*(?:<[^>]*>)?\(/g;
		for (const name of readdirSync(helpersDir).filter((f) => f.endsWith(".rs"))) {
			const text = readFileSync(join(helpersDir, name), "utf-8");
			for (const match of text.matchAll(pubFn)) {
				const module = name === "mod.rs" ? "helpers" : `helpers::${name.slice(0, -3)}`;
				listing.libFunctions.push(`${module}::${match[1]}`);
			}
		}
		listing.libFunctions.sort();
	}
	return listing;
}

/** Scratch dir mounted at /scratch (session-temp; rw). */
export function createScratchDir(workspaceDir: string): string {
	const dir = join(workspaceDir, ".scratch");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function ensureStateDir(workspaceDir: string): string {
	const dir = join(workspaceDir, "state");
	mkdirSync(dir, { recursive: true });
	return dir;
}
