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

export function resolveToolchain(): ToolchainInfo {
	const cargoBin =
		process.env.WASMEDGE_AGENT_CARGO ?? findOnPath("cargo") ?? join(homedir(), ".cargo", "bin", "cargo");
	if (!existsSync(cargoBin)) {
		throw new Error(`cargo not found (checked WASMEDGE_AGENT_CARGO, PATH, ~/.cargo/bin)`);
	}

	const wasmedgeBin =
		process.env.WASMEDGE_AGENT_WASMEDGE ?? findOnPath("wasmedge") ?? join(homedir(), ".wasmedge", "bin", "wasmedge");
	if (!existsSync(wasmedgeBin)) {
		throw new Error(`wasmedge not found; install it or set WASMEDGE_AGENT_WASMEDGE to the binary path`);
	}

	const targets = execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf-8" });
	if (!targets.includes("wasm32-wasip1")) {
		throw new Error(`rust target wasm32-wasip1 missing; run: rustup target add wasm32-wasip1`);
	}

	const wasmedgeVersion = execFileSync(wasmedgeBin, ["--version"], { encoding: "utf-8" }).trim();
	return { cargoBin, wasmedgeBin, wasmedgeVersion };
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
