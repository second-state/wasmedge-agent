export type WorkspaceWritePolicy = "rw" | "ro";

export function normalizeWorkspaceWritePolicy(value: unknown): WorkspaceWritePolicy {
	if (value === undefined) return "rw";
	if (value === "rw" || value === "ro") return value;
	throw new Error('rustCell.workspaceWritePolicy must be "rw" or "ro"');
}
