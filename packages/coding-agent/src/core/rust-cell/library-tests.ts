import { type CrateTestOptions, testRustCrate } from "./crate-tests.js";
import type { LibFile } from "./types.js";

export function normalizeLibraryTestGate(value: unknown): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	throw new Error("rustCell.libraryTestGate must be a boolean");
}

/** Test proposed library edits on an isolated snapshot before the runner applies them. */
export function testLibraryEdits(lib: LibFile[], options: CrateTestOptions): Promise<void> {
	return testRustCrate("agent_lib", options, lib);
}
