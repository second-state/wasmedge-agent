import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { readJson, record, writeJson } from "./files.js";
import type { Trace } from "./trace.js";
import type { CargoCapture } from "./types.js";

export function captureCargo(trace: Trace, sourceRoot: string, env: NodeJS.ProcessEnv): void {
	const calibration = Array.from({ length: 3 }, () => {
		const before = process.hrtime.bigint();
		const child = BigInt(
			execFileSync(process.execPath, ["-e", "process.stdout.write(process.hrtime.bigint().toString())"], {
				env,
				encoding: "utf8",
			}),
		);
		const after = process.hrtime.bigint();
		return {
			before: before.toString(),
			child: child.toString(),
			after: after.toString(),
			pass: before <= child && child <= after,
		};
	});
	writeJson(join(trace.directory, "cargo-clock-calibration.json"), { clockId: trace.clockId, calibration });
	if (calibration.some((sample) => !sample.pass))
		throw new Error("Cargo child monotonic clock cannot align with collector");
	const real = execFileSync("/bin/sh", ["-c", "command -v cargo"], { env, encoding: "utf8" }).trim();
	if (!real.startsWith("/")) throw new Error("Cannot resolve the original Cargo executable");
	const bin = join(trace.directory, "cargo-bin"),
		log = join(trace.directory, "cargo-commands.jsonl"),
		script = join(bin, "cargo.mjs"),
		shim = join(bin, "cargo");
	mkdirSync(bin, { recursive: true, mode: 0o700 });
	writeFileSync(log, "", { mode: 0o600 });
	const template = readFileSync(join(sourceRoot, "poc/bench/three-way/templates/command.mjs"), "utf8");
	writeFileSync(
		script,
		template
			.replaceAll("@REAL_JSON@", JSON.stringify(real))
			.replaceAll("@LOG_JSON@", JSON.stringify(log))
			.replace("const common = {", `const common = { clockId: ${JSON.stringify(trace.clockId)},`),
		{ mode: 0o600 },
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
	env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
	env.WASMEDGE_AGENT_CARGO = shim;
	if (env.WASMEDGE_AGENT_WASMEDGE) {
		const aotLog = join(trace.directory, "aot-commands.jsonl"),
			aotScript = join(bin, "aot.mjs"),
			aotShim = join(bin, "aot");
		writeFileSync(aotLog, "", { mode: 0o600 });
		writeFileSync(
			aotScript,
			template
				.replaceAll("@REAL_JSON@", JSON.stringify(env.WASMEDGE_AGENT_WASMEDGE))
				.replaceAll("@LOG_JSON@", JSON.stringify(aotLog))
				.replace("const common = {", `const common = { clockId: ${JSON.stringify(trace.clockId)},`),
			{ mode: 0o600 },
		);
		writeFileSync(aotShim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(aotScript)} "$@"\n`, { mode: 0o700 });
		env.WASMEDGE_AGENT_AOT_COMPILER = aotShim;
	}
	trace.event("cargo_capture_enabled", {
		real,
		shim,
		clockVerified: true,
		coverage: "pinned-runtime-cargo-override-and-checker-PATH",
		wrapperOverheadAudited: false,
	});
}

export function importCargo(trace: Trace, kind: "cargo" | "aot" = "cargo"): CargoCapture {
	const errors: string[] = [],
		starts = new Map<string, Record<string, unknown>>(),
		ends = new Set<string>();
	const capture: CargoCapture = {
		version: 1,
		complete: false,
		clockVerified: false,
		startedCommands: 0,
		completedCommands: 0,
		errors,
		method: kind === "cargo" ? "cargo-path-and-runtime-override" : "aot-runtime-override",
	};
	try {
		const proof = readJson(join(trace.directory, "cargo-clock-calibration.json"));
		capture.clockVerified =
			record(proof) &&
			proof.clockId === trace.clockId &&
			Array.isArray(proof.calibration) &&
			proof.calibration.length === 3 &&
			proof.calibration.every(
				(sample) =>
					record(sample) &&
					sample.pass === true &&
					[sample.before, sample.child, sample.after].every(
						(value) => typeof value === "string" && /^\d+$/.test(value),
					) &&
					BigInt(String(sample.before)) <= BigInt(String(sample.child)) &&
					BigInt(String(sample.child)) <= BigInt(String(sample.after)),
			);
	} catch {
		capture.clockVerified = false;
	}
	if (!capture.clockVerified) errors.push("Missing or invalid shared-clock calibration");
	for (const line of readFileSync(join(trace.directory, `${kind}-commands.jsonl`), "utf8")
		.split("\n")
		.filter(Boolean)) {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			errors.push("Truncated Cargo record");
			continue;
		}
		if (
			!record(value) ||
			typeof value.id !== "string" ||
			!["start", "end"].includes(String(value.type)) ||
			value.clockId !== trace.clockId ||
			typeof value.startMonoNs !== "string" ||
			!/^\d+$/.test(value.startMonoNs) ||
			typeof value.pid !== "number" ||
			typeof value.executable !== "string" ||
			!Array.isArray(value.args) ||
			!value.args.every((arg) => typeof arg === "string")
		) {
			errors.push("Invalid Cargo metadata or clock");
			continue;
		}
		if (value.type === "start") {
			if (starts.has(value.id)) errors.push(`Duplicate Cargo start: ${value.id}`);
			starts.set(value.id, value);
			continue;
		}
		const start = starts.get(value.id);
		if (
			!start ||
			ends.has(value.id) ||
			["pid", "clockId", "startMonoNs", "executable", "cwd", "args"].some(
				(key) => JSON.stringify(start[key]) !== JSON.stringify(value[key]),
			) ||
			typeof value.endMonoNs !== "string" ||
			!/^\d+$/.test(value.endMonoNs) ||
			BigInt(value.endMonoNs) < BigInt(value.startMonoNs)
		) {
			errors.push(`Unmatched Cargo end: ${value.id}`);
			continue;
		}
		ends.add(value.id);
		const begin = BigInt(value.startMonoNs),
			end = BigInt(value.endMonoNs);
		const contains = (name: string) =>
			trace.spans.some(
				(span) =>
					span.name === name &&
					span.clockId === trace.clockId &&
					span.startMonoNs &&
					span.endMonoNs &&
					begin >= BigInt(span.startMonoNs) &&
					end <= BigInt(span.endMonoNs),
			);
		const firstRequest = trace.spans
			.filter((span) => span.name === "llm.request" && span.clockId === trace.clockId && span.startMonoNs)
			.map((span) => BigInt(span.startMonoNs!))
			.sort((a, b) => (a < b ? -1 : 1))[0];
		const stage = contains("task.check")
			? "checker"
			: value.args.includes("cell")
				? "cell"
				: contains("runtime.start") || (firstRequest !== undefined && end <= firstRequest)
					? "initialization"
					: value.args.includes("test")
						? "library-test"
						: "other";
		trace.add({
			name: `${kind}.command`,
			commandId: value.id,
			processId: value.pid,
			clockId: trace.clockId,
			startMonoNs: value.startMonoNs,
			endMonoNs: value.endMonoNs,
			durationMs: Number(end - begin) / 1e6,
			measurementState: "measured",
			outcome: value.exitCode === 0 ? "ok" : "error",
			attributes: {
				args: value.args,
				executable: value.executable,
				cwd: value.cwd,
				exitCode: value.exitCode,
				signal: value.signal,
				stage: kind === "aot" ? "cell" : stage,
				inclusive: true,
				provenance: `${kind}-wrapper-command-wall`,
				clockCalibration: "cargo-clock-calibration.json",
				includes: "spawn-to-close-including-tests-and-stdio-drain",
				wrapperOverheadAudited: false,
			},
		});
	}
	for (const id of starts.keys()) if (!ends.has(id)) errors.push(`Incomplete Cargo command: ${id}`);
	capture.startedCommands = starts.size;
	capture.completedCommands = ends.size;
	capture.complete = errors.length === 0;
	writeJson(join(trace.directory, `${kind}-capture.json`), capture);
	return capture;
}
