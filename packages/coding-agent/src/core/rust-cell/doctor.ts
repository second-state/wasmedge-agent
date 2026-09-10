/** Runtime health checks for `doctor` (DESIGN.md §10): toolchain, template,
 * vendor. Never throws — every probe degrades to a failed check with a fix
 * hint. */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	ensureTemplateReady,
	findCargoBin,
	findRustupBin,
	isTemplateVendored,
	isTemplateWarm,
	probeWasmedge,
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

	// Running it is the check. A file at the path is not: a partial extraction,
	// an interrupted package install, or a build against another libc all leave
	// an executable that cannot start, and this check recorded that failure in
	// the detail text while still reporting ok -- so the installer, which reads
	// `ok` alone, finished on a host whose first rust cell could not run.
	const wasmedge = probeWasmedge();
	const wasmedgeOk = wasmedge.version !== undefined;
	checks.push({
		name: "wasmedge",
		ok: wasmedgeOk,
		detail:
			wasmedge.version ??
			(wasmedge.bin
				? `${wasmedge.bin} (--version failed)`
				: "not found (checked WASMEDGE_AGENT_WASMEDGE, PATH, ~/.wasmedge/bin)"),
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
