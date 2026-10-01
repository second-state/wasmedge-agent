import { isDeepStrictEqual } from "node:util";
import type { HostRequestHandler } from "../host-bridge/types.js";
import {
	type HarnessEntry,
	type HarnessScope,
	loadHarnessState,
	type RefinementKind,
	type SkillTestValidator,
	saveHarnessState,
	validateRustSkillReference,
} from "./refinement.js";

const KINDS: RefinementKind[] = ["prompt", "memory", "skill", "subagent"];

function string(payload: Record<string, unknown>, key: string): string {
	const value = payload[key];
	if (typeof value !== "string") throw new Error(`harness request requires ${key} as a string`);
	return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`harness request requires ${field} as an object`);
	}
	return value as Record<string, unknown>;
}

function kind(value: unknown): RefinementKind {
	if (!KINDS.includes(value as RefinementKind)) throw new Error(`unknown harness kind ${String(value)}`);
	return value as RefinementKind;
}

function entry(records: Record<string, HarnessEntry>, id: string): HarnessEntry | undefined {
	return Object.hasOwn(records, id) ? records[id] : undefined;
}

function stripScope(id: string, scope: HarnessScope): string {
	const colon = id.indexOf(":");
	if (colon < 0) return id;
	const prefix = id.slice(0, colon);
	if (prefix === scope) return id.slice(colon + 1);
	if (prefix === "local" || prefix === "global") {
		throw new Error(`entry ${id} belongs to the ${prefix} store; use rlm::harness::${prefix}()`);
	}
	return id;
}

/** The host chooses the store and owns persistence. Guest requests cannot
 * supply a file path, a replacement state, or their own skill-test result. */
export function createHarnessHostHandler(options: {
	resolveDirectory: (scope: HarnessScope) => string | undefined;
	testSkill?: SkillTestValidator;
}): HostRequestHandler {
	return async (payload, context) => {
		context?.signal.throwIfAborted();
		const scope = payload.scope;
		if (scope !== "local" && scope !== "global") throw new Error("harness scope must be local or global");
		const directory = options.resolveDirectory(scope);
		if (!directory) throw new Error(`${scope} harness state is unavailable in this session`);
		const operation = string(payload, "operation");
		if (operation === "open") return { value: true };
		let state = loadHarnessState(directory, scope);
		if (operation === "list" || operation === "overview") {
			const kinds = operation === "list" && payload.kind != null ? [kind(payload.kind)] : KINDS;
			const entries = (k: RefinementKind) =>
				Object.keys(state.entries[k])
					.sort()
					.map((id) => state.entries[k][id]);
			if (operation === "list") return { value: kinds.flatMap(entries) };
			const lines = kinds.flatMap((k) => [
				`${k} (${Object.keys(state.entries[k]).length}):`,
				...entries(k).map((e) => {
					const chars = Array.from(e.content.replaceAll("\n", " "));
					const content = chars.slice(0, 120).join("") + (chars.length > 120 ? "…" : "");
					return `- [${e.scope}:${e.id}] ${e.title} (${e.path}, v${e.version}): ${content}`;
				}),
			]);
			lines.push(`refinements: ${state.refinements.length}`);
			return { value: lines.join("\n") };
		}
		if (operation === "record_refinement") {
			const changes = payload.changes;
			if (!Array.isArray(changes) || !changes.every((change) => typeof change === "string")) {
				throw new Error("harness refinement changes must be strings");
			}
			const event = {
				id: `refine_${String(state.refinements.length + 1).padStart(4, "0")}`,
				trigger: string(payload, "trigger"),
				changes,
				evidence: string(payload, "evidence"),
				outcome: string(payload, "outcome"),
				created_at: new Date().toISOString(),
			};
			state.refinements.push(event);
			saveHarnessState(directory, state);
			return { value: event };
		}
		if (!["get", "delete", "create", "update"].includes(operation)) {
			throw new Error(`unknown harness operation ${operation}`);
		}
		const k = kind(payload.kind);
		const title = operation === "create" || operation === "update" ? string(payload, "title") : "";
		const id =
			operation === "create"
				? title
						.trim()
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "_")
						.replace(/^_+|_+$/g, "")
						.slice(0, 80) || k
				: stripScope(string(payload, "id"), scope);
		const before = entry(state.entries[k], id);
		if (operation === "get") return { value: before ?? null };
		if (k === "prompt" && id === "base_system_prompt") throw new Error("base system prompt is not editable");
		if (operation === "delete") {
			if (before) {
				delete state.entries[k][id];
				saveHarnessState(directory, state);
			}
			return { value: before !== undefined };
		}
		if (operation === "create" && before) throw new Error(`${k} entry ${id} already exists`);
		if (operation === "update" && !before) throw new Error(`${k} entry ${id} does not exist`);
		const content = string(payload, "content");
		const reference =
			k === "skill" && payload.reference !== undefined
				? record(payload.reference, "reference")
				: (before?.reference ?? {});
		const args =
			k === "skill" && payload.arguments !== undefined
				? record(payload.arguments, "arguments")
				: (before?.arguments ?? {});
		if (k === "skill") {
			const error = validateRustSkillReference(reference);
			if (error) throw new Error(error);
			if (operation === "create" && payload.arguments === undefined) throw new Error("skill requires arguments");
			if (!options.testSkill) throw new Error("sandboxed skill tests are unavailable");
			await options.testSkill(reference, context?.signal);
			context?.signal.throwIfAborted();
			// A test yields to other cells and /refine. Reload even if mtime did
			// not move, preserving unrelated writes and rejecting same-entry edits.
			state = loadHarnessState(directory, scope);
			if (!isDeepStrictEqual(entry(state.entries[k], id), before)) {
				throw new Error(`skill entry ${id} changed while tests ran; retry the ${operation}`);
			}
		}
		const now = new Date().toISOString();
		const after: HarnessEntry = {
			...(before ?? {
				id,
				kind: k,
				path: "general",
				scope,
				metadata: {},
				source: "agent",
				created_at: now,
			}),
			title,
			content,
			reference,
			arguments: args,
			updated_at: now,
			version: (before?.version ?? 0) + 1,
		};
		state.entries[k][id] = after;
		saveHarnessState(directory, state);
		return { value: after };
	};
}
