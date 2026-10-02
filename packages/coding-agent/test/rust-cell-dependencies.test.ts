import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CELL_DEPENDENCIES_FILE,
	curatedDependency,
	readCellDependencies,
	workspaceDependencies,
} from "../src/core/rust-cell/dependency-catalog.js";
import {
	DEPENDENCY_PATHS,
	dependencyTransactionDir,
	recoverDependencyUpdate,
	updateDependencies,
} from "../src/core/rust-cell/dependency-transaction.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "deps-update-test-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	for (const path of DEPENDENCY_PATHS) {
		mkdirSync(dirname(join(workspace, path)), { recursive: true });
		if (path !== CELL_DEPENDENCIES_FILE) writeFileSync(join(workspace, path), "previous");
	}
	mkdirSync(join(workspace, "state"));
	writeFileSync(join(workspace, "state/keep"), "state");
	return { root, workspace };
}
function stage(workspace: string, next: string) {
	cpSync(workspace, next, { recursive: true });
	for (const path of DEPENDENCY_PATHS) writeFileSync(join(next, path), "next");
}
function unchanged(workspace: string) {
	for (const path of DEPENDENCY_PATHS) {
		if (path === CELL_DEPENDENCIES_FILE) expect(existsSync(join(workspace, path))).toBe(false);
		else expect(readFileSync(join(workspace, path), "utf-8")).toBe("previous");
	}
	expect(readFileSync(join(workspace, "state/keep"), "utf-8")).toBe("state");
}

describe("curated dependency policy", () => {
	it.each([undefined, "serde", "reqwest", "../itoa", "ITOA", "regex_automata", "constructor", { name: "itoa" }])(
		"rejects non-catalog names: %j",
		(name) => {
			expect(() => curatedDependency(name)).toThrow("curated crate name");
		},
	);
	it("validates persisted names and preserves explicit user configuration", () => {
		const { workspace } = fixture();
		writeFileSync(join(workspace, CELL_DEPENDENCIES_FILE), '["itoa", "itoa", "base64"]');
		expect(readCellDependencies(workspace)).toEqual(["base64", "itoa"]);
		expect(workspaceDependencies([{ name: "itoa", version: "1.0.18", defaultFeatures: false }], ["itoa"])).toEqual([
			{ name: "itoa", version: "1.0.18", defaultFeatures: false, features: [] },
		]);
		writeFileSync(join(workspace, CELL_DEPENDENCIES_FILE), '["reqwest"]');
		expect(() => readCellDependencies(workspace)).toThrow("curated crate name");
		writeFileSync(join(workspace, CELL_DEPENDENCIES_FILE), "{}");
		expect(() => readCellDependencies(workspace)).toThrow("Invalid dependency record");
	});
});

describe("dependency publication", () => {
	it("publishes only dependency files, preserving state written during preparation", async () => {
		const { workspace } = fixture();
		await updateDependencies(
			workspace,
			async (next) => {
				stage(workspace, next);
				writeFileSync(join(workspace, "state/keep"), "written during build");
			},
			new AbortController().signal,
		);
		for (const path of DEPENDENCY_PATHS) expect(readFileSync(join(workspace, path), "utf-8")).toBe("next");
		expect(readFileSync(join(workspace, "state/keep"), "utf-8")).toBe("written during build");
	});
	it.each(["build failure", "cancel", "partial publish"])("retains originals on %s", async (failure) => {
		const { workspace } = fixture();
		const controller = new AbortController();
		await expect(
			updateDependencies(
				workspace,
				async (next) => {
					stage(workspace, next);
					if (failure === "build failure") throw new Error("build failed");
					if (failure === "cancel") controller.abort();
					if (failure === "partial publish") rmSync(join(next, DEPENDENCY_PATHS[4]));
				},
				controller.signal,
			),
		).rejects.toThrow();
		unchanged(workspace);
		expect(existsSync(dependencyTransactionDir(workspace))).toBe(false);
	});
	it.each(Array.from({ length: DEPENDENCY_PATHS.length * 2 + 1 }, (_, n) => n))(
		"recovers interruption after %i rename operations",
		(steps) => {
			const { workspace } = fixture();
			const transaction = dependencyTransactionDir(workspace);
			const next = join(transaction, "next");
			stage(workspace, next);
			const originals = DEPENDENCY_PATHS.map((path) => existsSync(join(workspace, path)));
			writeFileSync(join(transaction, "owner.json"), JSON.stringify({ pid: 0, phase: "publishing", originals }));
			for (const [index, path] of DEPENDENCY_PATHS.entries()) {
				const backup = join(transaction, "previous", path);
				mkdirSync(dirname(backup), { recursive: true });
				if (index * 2 < steps && originals[index]) renameSync(join(workspace, path), backup);
				if (index * 2 + 1 < steps) renameSync(join(next, path), join(workspace, path));
			}
			recoverDependencyUpdate(workspace);
			unchanged(workspace);
			expect(existsSync(transaction)).toBe(false);
		},
	);
	it("retains committed updates and refuses active owners", () => {
		const { workspace } = fixture();
		const transaction = dependencyTransactionDir(workspace);
		cpSync(workspace, join(transaction, "previous"), { recursive: true });
		for (const path of DEPENDENCY_PATHS) writeFileSync(join(workspace, path), "committed");
		const journal = { pid: process.pid, phase: "committed", originals: DEPENDENCY_PATHS.map(() => true) };
		writeFileSync(join(transaction, "owner.json"), JSON.stringify(journal));
		expect(() => recoverDependencyUpdate(workspace)).toThrow("already running");
		writeFileSync(join(transaction, "owner.json"), JSON.stringify({ ...journal, pid: 0 }));
		recoverDependencyUpdate(workspace);
		for (const path of DEPENDENCY_PATHS) expect(readFileSync(join(workspace, path), "utf-8")).toBe("committed");
		expect(existsSync(transaction)).toBe(false);
	});
	it("rejects symlinked scaffold parents without touching their target", async () => {
		const { root, workspace } = fixture();
		renameSync(join(workspace, "agent_lib"), join(root, "external"));
		symlinkSync(join(root, "external"), join(workspace, "agent_lib"));
		await expect(updateDependencies(workspace, async () => {}, new AbortController().signal)).rejects.toThrow(
			"regular scaffold directory",
		);
		expect(readFileSync(join(root, "external/Cargo.toml"), "utf-8")).toBe("previous");
	});
});
