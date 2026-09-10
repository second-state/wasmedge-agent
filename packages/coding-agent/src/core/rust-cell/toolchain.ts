/** Toolchain discovery: cargo + wasmedge binaries and one-time template warm
 * build. Mirrors ensureKernelPython's role at PoC scale (DESIGN.md §2.2). */

import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveTemplateDir } from "./workspace.js";

export interface ToolchainInfo {
	cargoBin: string;
	wasmedgeBin: string;
	wasmedgeVersion: string;
}

function findOnPath(bin: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(dir, bin);
		if (dir && existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Best-guess cargo location; existence is the caller's concern (doctor
 * reports it, resolveToolchain throws). */
export function findCargoBin(): string {
	return process.env.WASMEDGE_AGENT_CARGO ?? findOnPath("cargo") ?? join(homedir(), ".cargo", "bin", "cargo");
}

export function findRustupBin(): string {
	return findOnPath("rustup") ?? join(homedir(), ".cargo", "bin", "rustup");
}

/** Where wasmedge might be, in precedence order. An explicit override is the
 * only candidate it returns: pointing at a binary and silently getting a
 * different one is worse than being told this one does not work. */
export function wasmedgeCandidates(): string[] {
	const override = process.env.WASMEDGE_AGENT_WASMEDGE;
	if (override) return [override];
	const onPath = findOnPath("wasmedge");
	const home = join(homedir(), ".wasmedge", "bin", "wasmedge");
	return onPath && onPath !== home ? [onPath, home] : [home];
}

export interface WasmedgeProbe {
	/** The binary that ran, or the first one that exists and does not. */
	bin?: string;
	/** Set only when the binary ran. */
	version?: string;
}

/** The first candidate that runs. A broken binary ahead of a working one does
 * not hide it: selecting by existence meant a broken PATH entry won forever,
 * and reinstalling into ~/.wasmedge could not repair what was being selected. */
export function probeWasmedge(): WasmedgeProbe {
	let broken: string | undefined;
	for (const candidate of wasmedgeCandidates()) {
		if (!existsSync(candidate)) continue;
		try {
			return { bin: candidate, version: execFileSync(candidate, ["--version"], { encoding: "utf-8" }).trim() };
		} catch {
			broken ??= candidate;
		}
	}
	return { bin: broken };
}

/** Where wasmedge would be. Existence is the caller's concern, and whether it
 * runs is probeWasmedge's. */
export function findWasmedgeBin(): string {
	return wasmedgeCandidates()[0];
}

/** True when rustup exists but the wasm target is missing (fixable). False
 * also without rustup (e.g. distro/homebrew Rust): the precheck is skipped
 * and a genuinely missing target surfaces as the cargo build error. */
export function wasmTargetMissing(): boolean {
	const rustupBin = findRustupBin();
	if (!existsSync(rustupBin)) return false;
	const targets = execFileSync(rustupBin, ["target", "list", "--installed"], { encoding: "utf-8" });
	return !targets.includes("wasm32-wasip1");
}

export function resolveToolchain(): ToolchainInfo {
	const cargoBin = findCargoBin();
	if (!existsSync(cargoBin)) {
		throw new Error(`cargo not found (checked WASMEDGE_AGENT_CARGO, PATH, ~/.cargo/bin)`);
	}

	const wasmedge = probeWasmedge();
	if (wasmedge.version === undefined || wasmedge.bin === undefined) {
		throw new Error(
			wasmedge.bin === undefined
				? `wasmedge not found; install it or set WASMEDGE_AGENT_WASMEDGE to the binary path`
				: `wasmedge at ${wasmedge.bin} does not run; reinstall it or set WASMEDGE_AGENT_WASMEDGE`,
		);
	}

	if (wasmTargetMissing()) {
		throw new Error(`rust target wasm32-wasip1 missing; run: rustup target add wasm32-wasip1`);
	}

	return { cargoBin, wasmedgeBin: wasmedge.bin, wasmedgeVersion: wasmedge.version };
}

/** Build the template once so cloned workspaces start with a warm target/. */
export function warmTemplate(cargoBin: string): void {
	execFileSync(cargoBin, ["build", "--release", "-p", "cell"], {
		cwd: resolveTemplateDir(),
		stdio: "pipe",
	});
}

/** True when the template already has a compiled cell.wasm (warm cache). */
export function isTemplateWarm(): boolean {
	try {
		const template = resolveTemplateDir();
		return existsSync(join(template, "target", "wasm32-wasip1", "release", "cell.wasm"));
	} catch {
		return false;
	}
}

/** Vendor the locked dependency set into the template so every clone builds
 * hermetically (DESIGN.md §10). The template's committed .cargo/config.toml
 * already redirects crates-io at vendor/, so this only materializes the
 * sources — into a tmp dir first, renamed so a crash never leaves a
 * half-vendored dir that isTemplateVendored would trust. The only step that
 * may touch the network. */
export function vendorTemplate(cargoBin: string): void {
	const template = resolveTemplateDir();
	const tmp = join(template, "vendor.tmp");
	rmSync(tmp, { recursive: true, force: true });
	execFileSync(cargoBin, ["vendor", "--locked", tmp], {
		cwd: template,
		stdio: "pipe",
	});
	rmSync(join(template, "vendor"), { recursive: true, force: true });
	renameSync(tmp, join(template, "vendor"));
}

/** True when the template carries vendored sources. */
export function isTemplateVendored(): boolean {
	try {
		return existsSync(join(resolveTemplateDir(), "vendor"));
	} catch {
		return false;
	}
}

/** One-time template preparation: vendor the dependency set, then compile.
 * Idempotent; both postinstall and lazy first use funnel through here. */
export function ensureTemplateReady(cargoBin: string, onProgress?: (message: string) => void): void {
	if (!isTemplateVendored()) {
		onProgress?.("Vendoring cell workspace dependencies (one-time)...");
		vendorTemplate(cargoBin);
	}
	if (!isTemplateWarm()) {
		onProgress?.("Warming the cell workspace template (one-time)...");
		warmTemplate(cargoBin);
	}
}
