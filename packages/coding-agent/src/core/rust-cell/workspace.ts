/** Session workspace management: template clone, declarative lib-file
 * application with atomic revert (DESIGN.md D14), helpers/mod.rs
 * regeneration, and persistent-state listing for compaction/resume notices. */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LibFile } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Locate the guest workspace template: env override first, then the packaged
 * dist copy (copy-assets), then the repo-root source (running from source).
 * Mirrors the runtime-source resolution the kernel bootstrap used. */
export function resolveTemplateDir(): string {
	const override = process.env.WASMEDGE_AGENT_TEMPLATE_DIR;
	if (override) {
		// An explicit override must point at a workspace; falling back silently
		// would mask a misconfiguration.
		if (!existsSync(join(override, "Cargo.toml"))) {
			throw new Error(`WASMEDGE_AGENT_TEMPLATE_DIR is set but has no Cargo.toml: ${override}`);
		}
		return override;
	}
	const candidates = [
		// dist layout: dist/core/rust-cell -> dist/wasmedge-agent-runtime (copy-assets)
		resolve(HERE, "..", "..", "wasmedge-agent-runtime", "template"),
		// source layout: packages/coding-agent/src/core/rust-cell -> repo root
		resolve(HERE, "..", "..", "..", "..", "..", "wasmedge-agent-runtime", "template"),
	];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "Cargo.toml"))) return candidate;
	}
	throw new Error(`wasmedge-agent-runtime template not found (searched: ${candidates.join(", ")})`);
}

/** Clone the template into `dir` unless it is already provisioned. clonefile
 * on macOS carries the warm target/ cache for ~free; plain copy elsewhere. */
export function ensureWorkspaceAt(dir: string): string {
	if (existsSync(join(dir, "Cargo.toml"))) return dir;
	mkdirSync(dir, { recursive: true });
	const template = resolveTemplateDir();
	// Copy the template's contents (`src/.`), not the directory itself: `dir`
	// may already exist — the provisioner's mkdtemp fallback pre-creates it,
	// and skills may already be synced into it — and `cp src dst` onto an
	// existing dst would nest the template inside it.
	const clone = spawnSync("cp", ["-Rc", `${template}/.`, dir], { encoding: "utf-8" });
	if (clone.status !== 0) {
		execFileSync("cp", ["-R", `${template}/.`, dir]);
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

// ---------------------------------------------------------------------------
// Skills-as-crates mounting (DESIGN.md §4.1)
// ---------------------------------------------------------------------------

export interface RustSkillMount {
	name: string;
	/** Crate name; also the re-export path segment under agent_lib::skills::. */
	crateName: string;
	/** Absolute skill directory, mounted in place (editable semantics). */
	cratePath: string;
	cargoTomlPath: string;
}

export interface SyncRustSkillsResult {
	/** Crate names mounted and (when probed) compiling. */
	mounted: string[];
	/** Skills unmounted because their probe build failed. */
	failed: Array<{ name: string; message: string }>;
	/** False when the skill set and sources were already in sync (no writes). */
	changed: boolean;
}

const BASE_WORKSPACE_MEMBERS = ["agent_lib", "cell", "rlm"];
const SKILLS_DEP_BEGIN = "# --- skills (managed by wasmedge-agent; do not edit) ---";
const SKILLS_DEP_END = "# --- end skills ---";
const SKILLS_HASH_FILE = ".skills-hash";
const SKILLS_MOD_HEADER =
	"//! Skills-as-crates re-export mount point. Regenerated by the host on every\n" +
	"//! skill sync (DESIGN.md §4.1); do not edit by hand.\n";

function skillsFingerprint(skills: RustSkillMount[]): string {
	const entries = [...skills]
		.sort((a, b) => a.crateName.localeCompare(b.crateName))
		.map((skill) => {
			let manifest = "";
			try {
				manifest = readFileSync(skill.cargoTomlPath, "utf-8");
			} catch {
				// Missing manifest hashes as empty; the probe build will report it.
			}
			return `${skill.crateName}\n${skill.cratePath}\n${manifest}`;
		});
	return createHash("sha256").update(entries.join("\n---\n")).digest("hex");
}

/** Cargo requires members to live lexically below the workspace root, so
 * skills mount via `<workspace>/skills/<crate>` symlinks to their real
 * directories — editable semantics with a members-compatible path. */
function writeSkillSymlinks(workspaceDir: string, skills: RustSkillMount[]): void {
	const mountDir = join(workspaceDir, "skills");
	mkdirSync(mountDir, { recursive: true });
	const wanted = new Set(skills.map((skill) => skill.crateName));
	for (const entry of readdirSync(mountDir)) {
		if (!wanted.has(entry)) rmSync(join(mountDir, entry), { recursive: true, force: true });
	}
	for (const skill of skills) {
		const link = join(mountDir, skill.crateName);
		const current = lstatSync(link, { throwIfNoEntry: false });
		if (current) {
			if (current.isSymbolicLink() && readlinkSync(link) === skill.cratePath) continue;
			rmSync(link, { recursive: true, force: true });
		}
		symlinkSync(skill.cratePath, link);
	}
}

function writeWorkspaceMembers(workspaceDir: string, skills: RustSkillMount[]): void {
	const manifestPath = join(workspaceDir, "Cargo.toml");
	const manifest = readFileSync(manifestPath, "utf-8");
	const members = [...BASE_WORKSPACE_MEMBERS, ...skills.map((skill) => `skills/${skill.crateName}`)];
	const line = `members = [${members.map((member) => JSON.stringify(member)).join(", ")}]`;
	const updated = manifest.replace(/members = \[[^\]]*\]/, line);
	if (updated !== manifest) writeFileSync(manifestPath, updated);
}

function writeAgentLibSkillDeps(workspaceDir: string, skills: RustSkillMount[]): void {
	const manifestPath = join(workspaceDir, "agent_lib", "Cargo.toml");
	let manifest = readFileSync(manifestPath, "utf-8");
	const begin = manifest.indexOf(SKILLS_DEP_BEGIN);
	if (begin !== -1) {
		const end = manifest.indexOf(SKILLS_DEP_END);
		if (end === -1) throw new Error("agent_lib/Cargo.toml has an unterminated managed skills block");
		manifest = manifest.slice(0, begin) + manifest.slice(end + SKILLS_DEP_END.length + 1);
	}
	manifest = manifest.trimEnd();
	if (skills.length > 0) {
		const deps = skills
			.map((skill) => `${skill.crateName} = { path = ${JSON.stringify(`../skills/${skill.crateName}`)} }`)
			.join("\n");
		manifest += `\n${SKILLS_DEP_BEGIN}\n${deps}\n${SKILLS_DEP_END}\n`;
	} else {
		manifest += "\n";
	}
	writeFileSync(manifestPath, manifest);
}

function writeSkillsModRs(workspaceDir: string, skills: RustSkillMount[]): void {
	const modPath = join(workspaceDir, "agent_lib", "src", "skills", "mod.rs");
	mkdirSync(dirname(modPath), { recursive: true });
	const body = skills.map((skill) => `pub use ${skill.crateName};`).join("\n");
	writeFileSync(modPath, body ? `${SKILLS_MOD_HEADER}\n${body}\n` : SKILLS_MOD_HEADER);
}

function applySkillMounts(workspaceDir: string, skills: RustSkillMount[]): void {
	writeSkillSymlinks(workspaceDir, skills);
	writeWorkspaceMembers(workspaceDir, skills);
	writeAgentLibSkillDeps(workspaceDir, skills);
	writeSkillsModRs(workspaceDir, skills);
}

function probeBuild(workspaceDir: string, cargoBin: string, crate: string): { ok: boolean; message: string } {
	const result = spawnSync(cargoBin, ["build", "--release", "-p", crate], {
		cwd: workspaceDir,
		encoding: "utf-8",
	});
	if (result.status === 0) return { ok: true, message: "" };
	const output = `${result.stderr ?? ""}${result.error ? String(result.error) : ""}`.trim();
	return { ok: false, message: output.slice(-2000) || `cargo build -p ${crate} failed` };
}

/**
 * Mount skill crates into the workspace: workspace members + agent_lib path
 * dependencies + agent_lib::skills re-exports. Skills mount in place, so
 * editing a skill takes effect on the next cell compile. With a `cargoBin`,
 * each skill gets a probe build after a change and failures are unmounted
 * (one broken skill must not brick every cell); without one, mounts are
 * written unprobed.
 */
export function syncRustSkills(
	workspaceDir: string,
	skills: RustSkillMount[],
	options?: { cargoBin?: string },
): SyncRustSkillsResult {
	const hashPath = join(workspaceDir, SKILLS_HASH_FILE);
	const fingerprint = skillsFingerprint(skills);
	const previous = existsSync(hashPath) ? readFileSync(hashPath, "utf-8").trim() : undefined;
	if (previous === fingerprint) {
		return { mounted: skills.map((skill) => skill.crateName), failed: [], changed: false };
	}

	let active = [...skills];
	applySkillMounts(workspaceDir, active);
	const failed: SyncRustSkillsResult["failed"] = [];

	if (options?.cargoBin && active.length > 0) {
		const agentLib = probeBuild(workspaceDir, options.cargoBin, "agent_lib");
		if (!agentLib.ok) {
			// Attribute the breakage per skill, then remount only the healthy ones.
			for (const skill of [...active]) {
				const probe = probeBuild(workspaceDir, options.cargoBin, skill.crateName);
				if (!probe.ok) {
					failed.push({ name: skill.name, message: probe.message });
					active = active.filter((entry) => entry !== skill);
				}
			}
			applySkillMounts(workspaceDir, active);
			if (failed.length === 0) {
				// agent_lib itself is broken (e.g. stale helpers); surface that.
				failed.push({ name: "agent_lib", message: agentLib.message });
			}
		}
	}

	writeFileSync(hashPath, `${skillsFingerprint(active)}\n`);
	return { mounted: active.map((skill) => skill.crateName), failed, changed: true };
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
