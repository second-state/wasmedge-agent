export type RustCellRuntimeMode = "interpreter" | "aot";

export function normalizeRustCellRuntimeMode(value: unknown): RustCellRuntimeMode {
	if (value === undefined || value === "interpreter") return "interpreter";
	if (value === "aot") return "aot";
	throw new Error('rustCell.runtimeMode must be "interpreter" or "aot"');
}
