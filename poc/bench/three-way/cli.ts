import { resolve } from "node:path";
import { readJson, record, writeJson } from "./files.js";
import { prepare } from "./prepare.js";
import { discoverProvider } from "./provider.js";
import { analyze } from "./report.js";
import { plan, runPlan } from "./runner.js";
import type { Provider } from "./types.js";
import type { WorkloadOptions, WorkloadScale } from "./workloads/cases.js";

function options(argv: string[]): Map<string, string> {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		if (!key?.startsWith("--") || !value || value.startsWith("--") || values.has(key))
			throw new Error("Options require distinct --name value pairs");
		values.set(key.slice(2), value);
	}
	return values;
}

async function main(): Promise<void> {
	const command = process.argv[2];
	const args = options(process.argv.slice(3));
	if (command === "prepare") {
		await prepare(resolve("."), args.get("inputs"));
		return;
	}
	if (command === "plan") {
		if (args.has("numpy")) throw new Error("--numpy is no longer supported; workloads compare fixed algorithms only");
		const workloadOptions: WorkloadOptions = {
			scales: args.has("scales") ? (args.get("scales")!.split(",") as WorkloadScale[]) : undefined,
			batches: args.has("batches") ? args.get("batches")!.split(",").map(Number) : undefined,
			cache: args.has("cache") ? (args.get("cache")!.split(",") as ("cold" | "warm")[]) : undefined,
			warmups: args.has("warmups") ? Number(args.get("warmups")) : undefined,
			formats: args.has("event-format")
				? (args.get("event-format")!.split(",") as ("binary" | "jsonl")[])
				: undefined,
			simulationModes: args.has("simulation-mode")
				? (args.get("simulation-mode")!.split(",") as ("prng" | "events")[])
				: undefined,
		};
		if (args.has("tool-policy") && !["native", "runtime-only"].includes(args.get("tool-policy")!))
			throw new Error("--tool-policy must be native or runtime-only");
		if (args.has("profile-commands") && !["true", "false"].includes(args.get("profile-commands")!))
			throw new Error("--profile-commands must be true or false");
		let provider: Provider | null = null;
		if (args.has("provider")) {
			const value = readJson(resolve(args.get("provider")!));
			if (!record(value) || !record(value.provider)) throw new Error("Invalid discovery record");
			provider = value.provider as unknown as Provider;
		}
		const out = resolve(args.get("out") ?? `poc/bench/results/three-way-${Date.now()}`);
		const manifest = plan(
			resolve("."),
			resolve(args.get("prepared") ?? "poc/bench/results/three-way-inputs/prepared.json"),
			provider,
			args.get("suite") ?? "host",
			Number(args.get("reps") ?? 1),
			Number(args.get("seed") ?? 20261008),
			out,
			args.get("variants"),
			args.get("profile-commands") === "true",
			args.get("tool-policy") === "native" ? "native" : "runtime-only",
			workloadOptions,
		);
		console.log(
			JSON.stringify({
				plan: out,
				runs: manifest.runs.length,
				paidRuns: manifest.runs.filter((slot) => !["none-direct-runtime", "replay-fixed-v1"].includes(slot.modelId))
					.length,
			}),
		);
		return;
	}
	if (command === "run") {
		if (!args.has("plan")) throw new Error("run requires --plan DIRECTORY");
		await runPlan(resolve("."), resolve(args.get("plan")!));
		return;
	}
	if (command === "analyze") {
		if (!args.has("plan")) throw new Error("analyze requires --plan DIRECTORY");
		const report = analyze(resolve(args.get("plan")!));
		console.log(
			JSON.stringify({
				complete: report.complete,
				plannedRuns: report.plannedRuns,
				recordedRuns: report.recordedRuns,
				rankingAllowed: report.rankingAllowed,
			}),
		);
		return;
	}
	if (command === "discover") {
		const api = args.get("api") ?? "openai-completions";
		if (api !== "openai-completions" && api !== "anthropic-messages")
			throw new Error("--api must be openai-completions or anthropic-messages");
		const result = await discoverProvider(args.get("model"), api);
		const out = resolve(args.get("out") ?? "poc/bench/results/three-way-provider.json");
		writeJson(out, result);
		console.log(
			JSON.stringify({
				modelId: result.provider.modelId,
				api: result.provider.api,
				modelIdentity: result.provider.modelIdentity,
				out,
			}),
		);
		return;
	}
	throw new Error("Usage: npx tsx poc/bench/three-way/cli.ts <prepare|discover|plan|run|analyze> [--name value]");
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Benchmark command failed");
	process.exitCode = 1;
});
