import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { record } from "./files.js";
import type { Trace } from "./trace.js";

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function profileCommands(directory: string, sourceRoot: string, env: NodeJS.ProcessEnv): string {
	const bin = join(directory, "command-bin"),
		log = join(directory, "native-commands.jsonl");
	mkdirSync(bin, { recursive: true, mode: 0o700 });
	const template = readFileSync(join(sourceRoot, "poc/bench/three-way/templates/command.mjs"), "utf8");
	for (const name of ["cargo", "rustc", "node", "python", "python3"]) {
		let real: string;
		try {
			real = execFileSync("/bin/sh", ["-c", `command -v ${name}`], { env, encoding: "utf8" }).trim();
		} catch {
			continue;
		}
		if (!real.startsWith("/")) continue;
		const script = join(bin, `${name}.mjs`);
		writeFileSync(
			script,
			template.replaceAll("@REAL_JSON@", JSON.stringify(real)).replaceAll("@LOG_JSON@", JSON.stringify(log)),
		);
		const shim = join(bin, name);
		writeFileSync(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
		chmodSync(shim, 0o700);
	}
	return `${bin}${delimiter}${env.PATH ?? ""}`;
}

export function commandPhase(executable: string, args: string[]): string {
	const name = executable.split("/").at(-1);
	if (name === "cargo") {
		if (args.some((arg) => ["cell", "agent_lib", "rlm"].includes(arg))) return "compiler.control_cell_command";
		if (args.includes("test")) return "project.build_test_command";
		if (args.includes("build")) return "project.build_command";
		if (args.includes("check")) return "project.check_command";
		return "compiler.cargo_auxiliary";
	}
	if (name === "rustc") return "compiler.rustc_unit";
	if (name === "node" && args.includes("--test")) return "project.test_command";
	return "project.program_run";
}

export function importCommands(trace: Trace, path: string): void {
	for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			trace.event("command_record_error", { reason: "Truncated command telemetry line" });
			continue;
		}
		if (
			!record(value) ||
			value.type !== "end" ||
			typeof value.executable !== "string" ||
			!Array.isArray(value.args) ||
			!value.args.every((arg) => typeof arg === "string") ||
			typeof value.startMonoNs !== "string" ||
			typeof value.endMonoNs !== "string" ||
			typeof value.pid !== "number"
		)
			continue;
		trace.add({
			name: commandPhase(value.executable, value.args),
			commandId: String(value.id),
			processId: value.pid,
			clockId: `command-wrapper:${value.pid}:${String(value.id)}`,
			startMonoNs: value.startMonoNs,
			endMonoNs: value.endMonoNs,
			durationMs: Number(BigInt(value.endMonoNs) - BigInt(value.startMonoNs)) / 1e6,
			measurementState: "measured",
			outcome: value.exitCode === 0 ? "ok" : "error",
			attributes: {
				executable: value.executable,
				args: value.args,
				cwd: value.cwd,
				exitCode: value.exitCode,
				signal: value.signal,
				provenance: "profiling-wrapper-command-wall",
				inclusive: true,
				includes: "process-spawn-through-close-and-stdio-drain",
				phaseSeparation: "cargo-test-includes-build-and-tests",
				wrapperOverheadAudited: false,
			},
		});
	}
}
