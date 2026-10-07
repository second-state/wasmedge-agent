/** Toolchain discovery: cargo + wasmedge binaries and one-time template warm
 * build. Mirrors ensureKernelPython's role at PoC scale (DESIGN.md §2.2). */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { withBuildPermit } from "./build-gate.js";
import { cargoEnvironment } from "./cargo-environment.js";
import { type CargoSandbox, cargoCommand, cargoTargetDir } from "./cargo-sandbox.js";
import type { ProcessResourceGroup } from "./process-group.js";
import type { ProcessLimits } from "./process-limits.js";
import type { ProvisioningContext } from "./provisioning.js";
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

/** Probe beside the selected Cargo first, respecting an explicit RUSTC. */
export function rustcVersion(cargoBin: string, cwd: string): string {
	const rustc = findRustcBin(cargoBin);
	return execFileSync(rustc, ["--version", "--verbose"], {
		cwd,
		env: cargoEnvironment(),
		encoding: "utf-8",
		timeout: 30_000,
	}).trim();
}

function findRustcBin(cargoBin: string): string {
	const sibling = join(dirname(cargoBin), "rustc");
	return process.env.RUSTC ?? (existsSync(sibling) ? sibling : (findOnPath("rustc") ?? "rustc"));
}

export function rustcVersionAsync(cargoBin: string, cwd: string, context: ProvisioningContext): Promise<string> {
	return context.exec({ bin: findRustcBin(cargoBin), args: ["--version", "--verbose"], env: cargoEnvironment() }, cwd);
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
	const targets = execFileSync(rustupBin, ["target", "list", "--installed"], {
		env: cargoEnvironment(),
		encoding: "utf-8",
	});
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

/** Runtime probes use the same discovery order without blocking cancellation. */
export async function resolveToolchainAsync(context: ProvisioningContext): Promise<ToolchainInfo> {
	context.check();
	const cargoBin = findCargoBin();
	if (!existsSync(cargoBin)) throw new Error("cargo not found (checked WASMEDGE_AGENT_CARGO, PATH, ~/.cargo/bin)");
	let wasmedge: WasmedgeProbe = {};
	for (const candidate of wasmedgeCandidates()) {
		if (!existsSync(candidate)) continue;
		try {
			const version = await context.exec({ bin: candidate, args: ["--version"] }, process.cwd());
			wasmedge = { bin: candidate, version };
			break;
		} catch {
			context.check();
			wasmedge.bin ??= candidate;
		}
	}
	if (wasmedge.version === undefined || wasmedge.bin === undefined) {
		throw new Error(
			wasmedge.bin === undefined
				? "wasmedge not found; install it or set WASMEDGE_AGENT_WASMEDGE to the binary path"
				: `wasmedge at ${wasmedge.bin} does not run; reinstall it or set WASMEDGE_AGENT_WASMEDGE`,
		);
	}
	const rustup = findRustupBin();
	if (existsSync(rustup)) {
		const targets = await context.exec(
			{ bin: rustup, args: ["target", "list", "--installed"], env: cargoEnvironment() },
			process.cwd(),
		);
		if (!targets.includes("wasm32-wasip1"))
			throw new Error("rust target wasm32-wasip1 missing; run: rustup target add wasm32-wasip1");
	}
	return { cargoBin, wasmedgeBin: wasmedge.bin, wasmedgeVersion: wasmedge.version };
}

/** Build the template once so cloned workspaces start with a warm target/. */
export function warmTemplate(
	cargoBin: string,
	cargoSandbox?: CargoSandbox,
	processLimits?: ProcessLimits | null,
	processGroup?: ProcessResourceGroup | null,
): void {
	const command = cargoCommand(cargoBin, ["build", "--release", "-p", "cell"], {
		cwd: resolveTemplateDir(),
		cargoSandbox,
		processLimits,
		processGroup,
	});
	execFileSync(command.bin, command.args, {
		cwd: resolveTemplateDir(),
		env: command.env,
		stdio: "pipe",
	});
}

/** True when the template already has a compiled cell.wasm (warm cache). */
export function isTemplateWarm(cargoSandbox?: CargoSandbox): boolean {
	try {
		const template = resolveTemplateDir();
		return existsSync(join(cargoTargetDir(template, cargoSandbox), "wasm32-wasip1", "release", "cell.wasm"));
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
export function vendorTemplate(
	cargoBin: string,
	cargoSandbox?: CargoSandbox,
	processLimits?: ProcessLimits | null,
	processGroup?: ProcessResourceGroup | null,
): void {
	const template = resolveTemplateDir();
	const tmp = join(template, "vendor.tmp");
	rmSync(tmp, { recursive: true, force: true });
	const command = cargoCommand(cargoBin, ["vendor", "--locked", tmp], {
		cwd: template,
		cargoSandbox,
		processLimits,
		processGroup,
		network: true,
	});
	execFileSync(command.bin, command.args, {
		cwd: template,
		env: command.env,
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
export function ensureTemplateReady(
	cargoBin: string,
	onProgress?: (message: string) => void,
	cargoSandbox?: CargoSandbox,
	processLimits?: ProcessLimits | null,
	processGroup?: ProcessResourceGroup | null,
): void {
	if (!isTemplateVendored()) {
		onProgress?.("Vendoring cell workspace dependencies (one-time)...");
		vendorTemplate(cargoBin, cargoSandbox, processLimits, processGroup);
	}
	if (!isTemplateWarm(cargoSandbox)) {
		onProgress?.("Warming the cell workspace template (one-time)...");
		warmTemplate(cargoBin, cargoSandbox, processLimits, processGroup);
	}
}

const templatePreparations = new Map<string, Promise<void>>();

/** Serialize runtime preparation within this host. Each owner keeps its own
 * cancellation and resource policy; cancelling a waiter never kills the owner. */
export async function ensureTemplateReadyAsync(
	cargoBin: string,
	context: ProvisioningContext,
	onProgress?: (message: string) => void,
	cargoSandbox?: CargoSandbox,
	processLimits?: ProcessLimits | null,
	processGroup?: ProcessResourceGroup | null,
): Promise<void> {
	const template = realpathSync(resolveTemplateDir());
	while (templatePreparations.has(template)) {
		await context.wait(templatePreparations.get(template)!);
	}
	context.check();
	let release!: () => void;
	const preparing = new Promise<void>((resolve) => {
		release = resolve;
	});
	templatePreparations.set(template, preparing);
	try {
		if (!existsSync(join(template, "vendor"))) {
			onProgress?.("Vendoring cell workspace dependencies (one-time)...");
			context.check();
			const tmp = mkdtempSync(join(template, "vendor.tmp-"));
			try {
				await context.exec(
					cargoCommand(cargoBin, ["vendor", "--locked", tmp], {
						cwd: template,
						cargoSandbox,
						processLimits,
						processGroup,
						network: true,
					}),
					template,
				);
				// Another host may have published while we were fetching.
				if (!existsSync(join(template, "vendor"))) renameSync(tmp, join(template, "vendor"));
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		}
		if (!existsSync(join(cargoTargetDir(template, cargoSandbox), "wasm32-wasip1", "release", "cell.wasm"))) {
			onProgress?.("Warming the cell workspace template (one-time)...");
			context.check();
			await withBuildPermit(
				() =>
					context.exec(
						cargoCommand(cargoBin, ["build", "--release", "-p", "cell"], {
							cwd: template,
							cargoSandbox,
							processLimits,
							processGroup,
						}),
						template,
					),
				context.signal,
			);
		}
	} finally {
		templatePreparations.delete(template);
		release();
	}
}
