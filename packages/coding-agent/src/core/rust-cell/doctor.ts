/** Runtime health checks for `doctor` (DESIGN.md §10): toolchain, template,
 * vendor. Never throws — every probe degrades to a failed check with a fix
 * hint. */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	ensureTemplateReady,
	findCargoBin,
	findRustupBin,
	findWasmedgeBin,
	isTemplateVendored,
	isTemplateWarm,
	wasmTargetMissing,
} from "./toolchain.js";
import { resolveTemplateDir } from "./workspace.js";

export interface RuntimeCheck {
	name: string;
	ok: boolean;
	detail: string;
	/** How to repair a failed check; absent when doctor --fix handles it. */
	fix?: string;
}

export function collectRuntimeChecks(): RuntimeCheck[] {
	const checks: RuntimeCheck[] = [];

	const cargoBin = findCargoBin();
	const cargoOk = existsSync(cargoBin);
	checks.push({
		name: "cargo",
		ok: cargoOk,
		detail: cargoOk ? cargoBin : "not found (checked WASMEDGE_AGENT_CARGO, PATH, ~/.cargo/bin)",
		...(cargoOk ? {} : { fix: "install Rust via rustup.rs, or re-run install.sh" }),
	});

	const rustupBin = findRustupBin();
	if (existsSync(rustupBin)) {
		let missing: boolean;
		let detail: string;
		try {
			missing = wasmTargetMissing();
			detail = missing ? "missing" : "installed";
		} catch (error) {
			missing = true;
			detail = `rustup failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		checks.push({ name: "wasm32-wasip1 target", ok: !missing, detail });
	} else {
		checks.push({
			name: "wasm32-wasip1 target",
			ok: cargoOk,
			detail: cargoOk ? "rustup not found; precheck skipped (non-rustup Rust)" : "no Rust toolchain",
		});
	}

	const wasmedgeBin = findWasmedgeBin();
	const wasmedgeOk = existsSync(wasmedgeBin);
	let wasmedgeDetail = "not found (checked WASMEDGE_AGENT_WASMEDGE, PATH, ~/.wasmedge/bin)";
	if (wasmedgeOk) {
		try {
			wasmedgeDetail = execFileSync(wasmedgeBin, ["--version"], { encoding: "utf-8" }).trim();
		} catch {
			wasmedgeDetail = `${wasmedgeBin} (--version failed)`;
		}
	}
	checks.push({
		name: "wasmedge",
		ok: wasmedgeOk,
		detail: wasmedgeDetail,
		...(wasmedgeOk ? {} : { fix: "install WasmEdge (wasmedge.org), or re-run install.sh" }),
	});

	let templateDir: string | undefined;
	try {
		templateDir = resolveTemplateDir();
	} catch (error) {
		templateDir = undefined;
		checks.push({
			name: "workspace template",
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		});
	}
	if (templateDir) {
		checks.push({ name: "workspace template", ok: true, detail: templateDir });
		checks.push({
			name: "template vendor",
			ok: isTemplateVendored(),
			detail: isTemplateVendored() ? "vendored (hermetic builds)" : "not vendored",
		});
		checks.push({
			name: "template build",
			ok: isTemplateWarm(),
			detail: isTemplateWarm() ? "warm (cell.wasm compiled)" : "cold",
		});
	}

	return checks;
}

/** Repair what is repairable without installing software: add the wasm
 * target when rustup is present, then vendor + warm the template. Returns
 * one message per action taken (empty when nothing needed fixing). */
export function fixRuntime(): string[] {
	const messages: string[] = [];

	try {
		if (existsSync(findRustupBin()) && wasmTargetMissing()) {
			execFileSync(findRustupBin(), ["target", "add", "wasm32-wasip1"], { stdio: "pipe" });
			messages.push("added the wasm32-wasip1 target");
		}
	} catch (error) {
		messages.push(`rustup target add failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	const cargoBin = findCargoBin();
	if (existsSync(cargoBin) && (!isTemplateVendored() || !isTemplateWarm())) {
		try {
			ensureTemplateReady(cargoBin, (progress) => messages.push(progress));
		} catch (error) {
			messages.push(`template preparation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return messages;
}
