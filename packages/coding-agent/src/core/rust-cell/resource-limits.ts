import { normalizeProcessLimits, type ProcessLimits } from "./process-limits.js";

export interface CellResourceLimits {
	/** Optional Linux cgroup limits per Cargo/WasmEdge invocation and its descendants. */
	processLimits?: ProcessLimits | null;
	/** Optional gas budget per WasmEdge execution. Null/omitted keeps the runtime default. */
	cellGasLimit?: number | null;
	/** Optional maximum 64 KiB pages per Wasm linear memory. Not a process RSS limit. */
	cellMemoryPageLimit?: number | null;
}

export function validateCellResourceLimits(limits: CellResourceLimits): void {
	normalizeProcessLimits(limits.processLimits);
	// WasmEdge 0.14.1 narrows CLI gas limits to uint32_t. Reject overflow
	// instead of silently enforcing a different budget on that supported version.
	for (const [name, maximum] of [
		["cellGasLimit", 0xffff_ffff],
		["cellMemoryPageLimit", 65_536],
	] as const) {
		const value = limits[name];
		if (value == null) continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
			throw new Error(`rustCell.${name} must be an integer between 1 and ${maximum}, or null`);
		}
	}
}

export function wasmedgeResourceArgs(limits: CellResourceLimits): string[] {
	validateCellResourceLimits(limits);
	const args: string[] = [];
	// --gas-limit also enables cost measuring in WasmEdge.
	if (limits.cellGasLimit != null) args.push("--gas-limit", String(limits.cellGasLimit));
	if (limits.cellMemoryPageLimit != null) args.push("--memory-page-limit", String(limits.cellMemoryPageLimit));
	return args;
}
