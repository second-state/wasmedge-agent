import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CELL_DEPENDENCIES_FILE } from "./dependency-catalog.js";

// Replace dependency paths in place: replacing the workspace directory would detach a
// running guest's preopens and lose state written after its deps.add request.
// Append paths only: recovery also accepts the previous eight-file journal.
export const DEPENDENCY_PATHS = [
	"Cargo.toml",
	"Cargo.lock",
	"agent_lib/Cargo.toml",
	"agent_lib/src/lib.rs",
	"agent_lib/src/prelude.rs",
	"agent_lib/src/prelude_extra.rs",
	".workspace-version",
	CELL_DEPENDENCIES_FILE,
	"vendor",
] as const;

interface Journal {
	pid: number;
	phase: "preparing" | "publishing" | "committed";
	originals: boolean[];
}

export function dependencyTransactionDir(workspace: string): string {
	return join(dirname(workspace), `.${basename(workspace)}.deps-update`);
}

function writeJournal(transaction: string, journal: Journal): void {
	writeFileSync(join(transaction, "owner.tmp"), JSON.stringify(journal));
	renameSync(join(transaction, "owner.tmp"), join(transaction, "owner.json"));
}

export function assertDependencyPaths(workspace: string): void {
	const root = resolve(workspace);
	for (const path of DEPENDENCY_PATHS) {
		let parent = dirname(join(root, path));
		for (;;) {
			const stat = lstatSync(parent);
			if (!stat.isDirectory()) throw new Error(`Expected a regular scaffold directory: ${parent}`);
			if (parent === root) break;
			parent = dirname(parent);
		}
		const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
		const directory = path === "vendor";
		if (stat && !(directory ? stat.isDirectory() : stat.isFile())) {
			throw new Error(`Expected a regular scaffold ${directory ? "directory" : "file"}: ${path}`);
		}
	}
}

function rollback(workspace: string, transaction: string, journal: Journal): void {
	assertDependencyPaths(workspace);
	for (const [index, path] of DEPENDENCY_PATHS.slice(0, journal.originals.length).entries()) {
		const backup = join(transaction, "previous", path);
		if (existsSync(backup)) {
			rmSync(join(workspace, path), { recursive: path === "vendor", force: true });
			renameSync(backup, join(workspace, path));
		} else if (!journal.originals[index] && !existsSync(join(transaction, "next", path))) {
			rmSync(join(workspace, path), { recursive: path === "vendor", force: true });
		}
	}
}

/** A dead owner rolls back partial publication; a completed update is retained. */
export function recoverDependencyUpdate(workspace: string): void {
	const transaction = dependencyTransactionDir(workspace);
	if (!existsSync(transaction)) return;
	if (!lstatSync(transaction).isDirectory()) throw new Error("Invalid dependency transaction directory");
	const journal = JSON.parse(readFileSync(join(transaction, "owner.json"), "utf-8")) as Journal;
	if (
		!Number.isSafeInteger(journal.pid) ||
		journal.pid < 0 ||
		!["preparing", "publishing", "committed"].includes(journal.phase) ||
		!Array.isArray(journal.originals) ||
		![8, DEPENDENCY_PATHS.length].includes(journal.originals.length) ||
		!journal.originals.every((value) => typeof value === "boolean")
	) {
		throw new Error("Invalid dependency transaction journal");
	}
	if (journal.pid) {
		let active = true;
		try {
			process.kill(journal.pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") active = false;
		}
		if (active) throw new Error(`Dependency update already running (pid ${journal.pid})`);
	}
	if (journal.phase === "publishing") rollback(workspace, transaction, journal);
	rmSync(transaction, { recursive: true, force: true });
}

async function discardTransaction(transaction: string, journal: Journal): Promise<void> {
	await rm(transaction, { recursive: true, force: true }).finally(() => {
		if (existsSync(transaction)) writeJournal(transaction, { ...journal, pid: 0 });
	});
}

export async function updateDependencies(
	workspace: string,
	prepare: (staged: string) => Promise<void>,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	recoverDependencyUpdate(workspace);
	assertDependencyPaths(workspace);
	const transaction = dependencyTransactionDir(workspace);
	const journal: Journal = {
		pid: process.pid,
		phase: "preparing",
		originals: DEPENDENCY_PATHS.map((path) => existsSync(join(workspace, path))),
	};
	mkdirSync(transaction);
	writeJournal(transaction, journal);
	try {
		await prepare(join(transaction, "next"));
		signal.throwIfAborted();
		assertDependencyPaths(workspace);
		assertDependencyPaths(join(transaction, "next"));
		journal.phase = "publishing";
		writeJournal(transaction, journal);
		for (const [index, path] of DEPENDENCY_PATHS.entries()) {
			const backup = join(transaction, "previous", path);
			mkdirSync(dirname(backup), { recursive: true });
			if (journal.originals[index]) renameSync(join(workspace, path), backup);
			renameSync(join(transaction, "next", path), join(workspace, path));
		}
		writeJournal(transaction, { ...journal, phase: "committed" });
		journal.phase = "committed";
	} catch (error) {
		if (journal.phase === "publishing") {
			try {
				rollback(workspace, transaction, journal);
			} catch (restoreError) {
				writeJournal(transaction, { ...journal, pid: 0 });
				throw new Error("Dependency rollback failed; recovery required before continuing", { cause: restoreError });
			}
		}
		await discardTransaction(transaction, journal);
		throw error;
	}
	await discardTransaction(transaction, journal);
}
