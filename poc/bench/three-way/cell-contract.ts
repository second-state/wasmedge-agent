import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { record, sha256, writeJson } from "./files.js";
import type { Case, CellContractAudit, RunResult, VariantId } from "./types.js";
import { isWasmVariant } from "./types.js";

export const cellTool = (variant: VariantId): "rust" | "ipython" => (isWasmVariant(variant) ? "rust" : "ipython");
export const cellComparable = (run: RunResult): boolean =>
	!run.cellContract || ["compliant", "not-applicable"].includes(run.cellContract.status);

export function cellPrompt(task: string, variant: VariantId): string {
	const language = isWasmVariant(variant) ? "Rust" : "Python";
	return `${task}

CELL RUNTIME COMPARISON CONTRACT (overrides external-command instructions above):
Use the ${cellTool(variant)} tool and execute ${language} cells for the actual work in EVERY turn. Read, parse, compute, edit and write project files with ${language} language APIs. Do not delegate the work to bash, shell pipelines, external scripts, subprocesses or other tool calls, even from inside a cell. Do not read external skills or unrelated files.
The benchmark harness runs the project's original checker after your response, including node --test / cargo test where required. Do not launch those external commands yourself. Inspect the supplied tests as source and implement the requested changes within your cell; the host-side checker is timed separately.
${isWasmVariant(variant) ? "Project files are mounted at /workspace. Use std::fs for file I/O; submit a complete Rust program with fn main and use agent_lib::prelude::* as needed." : "Project files are in the kernel's project working directory. Use pathlib/open and Python computation; preserve reusable functions and data between turns."}
Each turn must include at least one successful cell execution. Finish only after writing the requested artifacts. This is a Python-cell/runtime versus Rust-cell/Wasm-runtime experiment, not a native tool-choice experiment.`;
}

export function auditCellContract(directory: string, item: Case, variant: VariantId): CellContractAudit {
	const expectedTool = cellTool(variant);
	const audit: CellContractAudit = {
		status:
			item.lane !== "end-to-end" ? "not-applicable" : item.tools !== "runtime-only" ? "not-controlled" : "compliant",
		expectedTool,
		observedTools: [],
		cellCalls: 0,
		successfulCells: 0,
		cellsPerTurn: Object.fromEntries(item.turns.map((_, index) => [`turn-${index + 1}`, 0])),
		violations: [],
		sources: [],
		sourceScreening: "literal-shell-api-screening; generated-source-review-required",
	};
	if (audit.status === "not-applicable") return audit;
	if (audit.status === "not-controlled") audit.violations.push("Tool choice was not restricted to the runtime cell");
	const eventFile = join(directory, "events.jsonl");
	const events: Record<string, unknown>[] = existsSync(eventFile)
		? readFileSync(eventFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.flatMap((line) => {
					const value: unknown = JSON.parse(line);
					return record(value) && value.type === "agent_event" && record(value.event)
						? [{ ...value.event, turnId: value.turnId }]
						: [];
				})
		: [];
	const starts = new Map<string, { turnId: string; hasSource: boolean }>();
	for (const event of events) {
		const id = String(event.toolCallId ?? "unknown"),
			turnId = String(event.turnId ?? "unknown");
		if (event.type === "tool_execution_start") {
			const tool = String(event.toolName ?? "unknown");
			if (!audit.observedTools.includes(tool)) audit.observedTools.push(tool);
			if (tool !== expectedTool) {
				audit.violations.push(`${turnId}: unexpected tool ${tool}; required ${expectedTool}`);
				continue;
			}
			audit.cellCalls++;
			const args = record(event.args) ? event.args : {};
			const sources = [typeof args.code === "string" ? args.code : ""];
			if (Array.isArray(args.lib))
				for (const lib of args.lib) if (record(lib) && typeof lib.content === "string") sources.push(lib.content);
			const hasSource = sources[0].trim().length > 0;
			starts.set(id, { turnId, hasSource });
			if (!hasSource) audit.violations.push(`${turnId}: missing generated cell code`);
			sources.forEach((code, index) => {
				const path = `cell-${audit.cellCalls}-${index}.${isWasmVariant(variant) ? "rs" : "py"}`;
				audit.sources.push({ toolCallId: id, turnId, path, sha256: sha256(code), bytes: Buffer.byteLength(code) });
				writeFileSync(join(directory, path), code, { mode: 0o600 });
				// A conservative protocol screen, not a security boundary or proof
				// against aliases. The saved sources also require actual code review.
				if (
					/\b(?:bash|shell|exec_command)\s*\(|\bsubprocess\b|\bos\s*\.\s*(?:system|popen|spawn\w*)\s*\(|\bstd\s*::\s*process\b|\bCommand\s*::\s*new\s*\(|\btools\s*::\s*bash\b|\bhost_request\s*\(\s*["'](?:bash|exec|command)/.test(
						code,
					)
				)
					audit.violations.push(`${turnId}: shell or external-process API in ${path}`);
			});
		}
		if (event.type === "tool_execution_end" && event.toolName === expectedTool) {
			const start = starts.get(id),
				result = record(event.result) ? event.result : {};
			const details = record(result.details) ? result.details : {};
			if (record(details.bashCommands) && Number(details.bashCommands.count ?? 0) > 0)
				audit.violations.push(`${turnId}: runtime reported a shell command`);
			const timings = record(details.timings) ? details.timings : {};
			const duration = isWasmVariant(variant) ? timings.executionMs : details.durationMs;
			if (
				start?.hasSource &&
				!event.isError &&
				details.status === "ok" &&
				typeof duration === "number" &&
				Number.isFinite(duration) &&
				duration >= 0
			) {
				audit.successfulCells++;
				audit.cellsPerTurn[start.turnId] = (audit.cellsPerTurn[start.turnId] ?? 0) + 1;
			}
			starts.delete(id);
		}
	}
	if (starts.size) audit.violations.push("Cell calls missing completion events");
	for (const [turn, count] of Object.entries(audit.cellsPerTurn))
		if (!count) audit.violations.push(`${turn}: no successful measured ${expectedTool} cell execution`);
	if (audit.status === "compliant" && audit.violations.length) audit.status = "violated";
	writeJson(join(directory, "cell-audit.json"), audit);
	return audit;
}
