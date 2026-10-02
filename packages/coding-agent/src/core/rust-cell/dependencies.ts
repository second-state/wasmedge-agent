import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostRequestHandler } from "../host-bridge/types.js";
import { withBuildPermit } from "./build-gate.js";
import {
	CELL_DEPENDENCIES_FILE,
	curatedDependency,
	readCellDependencies,
	workspaceDependencies,
} from "./dependency-catalog.js";
import { updateDependencies } from "./dependency-transaction.js";
import { type PreludeExtra, preludeConfigurationHash, writePreludeExtra } from "./prelude-extra.js";
import { runProcess } from "./process.js";
import { syncRustSkills } from "./workspace.js";
import type { WorkspaceHistory } from "./workspace-history.js";
import { snapshotWorkspace, withInheritedSkills } from "./workspace-snapshot.js";

export function createDependencyHandler(options: {
	workspace: string;
	template: string;
	cargoBin: string;
	configured: PreludeExtra[];
	timeoutMs: number;
	history?: WorkspaceHistory;
}): HostRequestHandler {
	let pending: Promise<unknown> = Promise.resolve();
	return (payload, context) => {
		const add = async (): Promise<Record<string, unknown>> => {
			if (!context) throw new Error("deps.add requires an active cell");
			const { signal } = context;
			signal.throwIfAborted();
			if (Object.keys(payload).some((key) => !["crate_name", "cellSourceCode"].includes(key))) {
				throw new Error("deps.add accepts only crate_name");
			}
			const { name } = curatedDependency(payload.crate_name);
			const { workspace } = options;
			const added = readCellDependencies(workspace);
			const previous = workspaceDependencies(options.configured, added);
			if (previous.some((extra) => extra.name.replaceAll("-", "_") === name.replaceAll("-", "_"))) {
				return { already_available: true };
			}
			const names = [...added, name].sort();
			const extras = workspaceDependencies(options.configured, names);
			const deadline = Date.now() + options.timeoutMs;
			await updateDependencies(
				workspace,
				async (staged) => {
					snapshotWorkspace(workspace, staged);
					copyFileSync(join(workspace, "cell/src/main.rs"), join(staged, "cell/src/main.rs"));
					for (const path of ["Cargo.toml", "agent_lib/Cargo.toml"]) {
						copyFileSync(join(options.template, path), join(staged, path));
					}
					const skills = withInheritedSkills(staged, []);
					if (skills.some((skill) => skill.crateName === name.replaceAll("-", "_"))) {
						throw new Error(`Curated crate conflicts with a mounted skill: ${name}`);
					}
					writePreludeExtra(staged, extras);
					syncRustSkills(staged, skills);
					const result = await withBuildPermit(
						() =>
							runProcess(options.cargoBin, ["build", "--release", "--offline", "-p", "cell"], {
								cwd: staged,
								timeoutMs: deadline - Date.now(),
								signal,
							}),
						signal,
					);
					signal.throwIfAborted();
					if (result.timedOut || result.exitCode !== 0) {
						throw new Error(
							`Dependency build failed; workspace unchanged: ${result.timedOut ? "timed out" : result.stderr}`,
						);
					}
					const versionPath = join(staged, ".workspace-version");
					const version = JSON.parse(readFileSync(versionPath, "utf-8"));
					writeFileSync(
						versionPath,
						`${JSON.stringify({ ...version, configurationHash: preludeConfigurationHash(extras) }, null, 2)}\n`,
					);
					writeFileSync(join(staged, CELL_DEPENDENCIES_FILE), `${JSON.stringify(names)}\n`);
				},
				signal,
			);
			try {
				options.history?.snapshotDependency(name);
			} catch (error) {
				throw new Error(
					`Dependency ${name} was added, but its Git snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return { already_available: false };
		};
		const result = pending.then(add);
		pending = result.catch(() => {});
		return result;
	};
}
