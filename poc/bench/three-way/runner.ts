import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { captureCargo, importCargo } from "./cargo.js";
import { cases } from "./cases.js";
import { auditCellContract, cellPrompt } from "./cell-contract.js";
import { importCommands, profileCommands } from "./commands.js";
import { hashTree, readJson, record, sha256, writeJson } from "./files.js";
import { startGateway } from "./gateway.js";
import type { Prepared } from "./prepare.js";
import {
	cleanEnvironment,
	killOwned,
	launch,
	type OwnedProcess,
	stopDaemon,
	timedProcess,
	waitDaemon,
} from "./process.js";
import { modelsConfig } from "./provider.js";
import { directRuntime, importCell, RuntimeDeadlineError } from "./runtime.js";
import { type StopSpan, Trace } from "./trace.js";
import {
	type Case,
	isWasmVariant,
	type Manifest,
	type Provider,
	type RunResult,
	type RunSlot,
	VARIANTS,
	type VariantId,
} from "./types.js";
import type { WorkloadOptions } from "./workloads/cases.js";
import { checkWorkloadTask, workloadOracleDirectory } from "./workloads/e2e.js";
import { generateFixture } from "./workloads/fixtures.js";

export function randomizedSlots(
	items: Case[],
	variants: VariantId[],
	repetitions: number,
	seed: number,
	modelId: string,
): RunSlot[] {
	let state = seed >>> 0;
	const random = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
	const slots: RunSlot[] = [];
	for (let repetition = 1; repetition <= repetitions; repetition++)
		for (const item of items) {
			const order = [...variants];
			for (let i = order.length - 1; i > 0; i--) {
				const j = Math.floor(random() * (i + 1));
				[order[i], order[j]] = [order[j], order[i]];
			}
			for (const variantId of order)
				slots.push({
					runId: `${item.id}-${variantId}-r${repetition}-${randomUUID()}`,
					variantId,
					caseId: item.id,
					repetition,
					caseHash: sha256(JSON.stringify(item)),
					modelId:
						item.lane === "end-to-end"
							? modelId
							: item.lane === "host"
								? "replay-fixed-v1"
								: "none-direct-runtime",
				});
		}
	return slots;
}

export function plan(
	root: string,
	preparedPath: string,
	provider: Provider | null,
	suite: string,
	repetitions: number,
	seed: number,
	out: string,
	selected: string = VARIANTS.join(","),
	commandProfiling = false,
	toolPolicy: "native" | "runtime-only" = "runtime-only",
	workloadOptions?: WorkloadOptions,
): Manifest {
	if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 1000)
		throw new Error("Repetitions must be 1..1000");
	const prepared = readJson(preparedPath) as Prepared;
	const variants = selected.split(",") as VariantId[];
	if (!variants.length || new Set(variants).size !== variants.length || variants.some((id) => !VARIANTS.includes(id)))
		throw new Error("Variants must be distinct supported IDs");
	const items = cases(root, suite, workloadOptions);
	for (const id of variants) {
		if (!prepared.variants.some((variant) => variant.id === id)) throw new Error(`Prepare missing variant: ${id}`);
		for (const item of items) {
			if (item.lane === "runtime" && !item.runtime?.[id]?.length)
				throw new Error(`Missing runtime cells: ${item.id}/${id}`);
			if (item.lane === "host" && !item.replay?.[id]?.length) throw new Error(`Missing replay: ${item.id}/${id}`);
		}
	}
	for (const item of items)
		if (item.lane === "end-to-end") {
			item.tools = toolPolicy;
			item.parameters.toolPolicy = toolPolicy;
			item.parameters.projectCache = "run-local-target-and-build-dir";
			item.parameters.experiment =
				toolPolicy === "runtime-only" ? "cell-runtime-comparison-v1" : "native-tool-choice-observation";
			item.parameters.validationPolicy =
				toolPolicy === "runtime-only" ? "external-checker-after-agent-no-shell-in-cells" : "native";
		}
	if (items.some((item) => item.lane === "end-to-end") && !provider)
		throw new Error("Paid tasks require discovery of the exact model route");
	if (existsSync(out)) throw new Error("Plan directory already exists; use run --plan to resume");
	mkdirSync(out, { recursive: true, mode: 0o700 });
	for (const item of items)
		if (item.taskDir) {
			const snapshot = join(out, "tasks", item.id);
			cpSync(item.taskDir, snapshot, { recursive: true });
			item.taskDir = snapshot;
			item.parameters.fixtureHash = hashTree(snapshot);
		}
	const manifest: Manifest = {
		version: 1,
		createdAt: new Date().toISOString(),
		seed,
		root: resolve(out),
		provider,
		variants: prepared.variants.filter((item) => variants.includes(item.id)),
		cases: items,
		runs: randomizedSlots(items, variants, repetitions, seed, provider?.modelId ?? "none"),
		requestLimitPerRun: 64,
		collectorSourceHash: hashTree(join(root, "poc/bench/three-way")),
		profileCommands: commandProfiling,
	};
	writeJson(join(out, "prepared.json"), prepared);
	cpSync(join(root, "poc/bench/three-way"), join(out, "collector"), { recursive: true });
	writeJson(join(out, "manifest.json"), manifest);
	writeJson(join(out, "environment.json"), {
		...prepared.identity,
		profile: "release",
		reasoning: "off",
		collectorOverheadAudited: false,
		rankingAllowed: false,
		resourceSampling: "disabled-by-default",
		commandProfiling,
		cargoCapture: "all-run-cargo-wall-v1",
	});
	return manifest;
}

function findSession(agentDir: string): string | null {
	const directory = join(agentDir, "sessions");
	if (!existsSync(directory)) return null;
	const files = readdirSync(directory)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(directory, name))
		.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
	return files.at(-1) ?? null;
}

function fixture(item: Case, project: string): void {
	mkdirSync(project, { recursive: true, mode: 0o700 });
	if (item.taskDir && existsSync(join(item.taskDir, "fixture")))
		cpSync(join(item.taskDir, "fixture"), project, { recursive: true });
	for (const [path, content] of Object.entries(item.fixture)) {
		const target = resolve(project, path);
		if (!target.startsWith(`${project}/`)) throw new Error("Fixture path escapes project");
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}

async function runOne(manifest: Manifest, prepared: Prepared, slot: RunSlot, item: Case): Promise<RunResult> {
	const directory = join(manifest.root, "runs", slot.runId);
	if (existsSync(directory)) throw new Error("Incomplete run retained; create a new plan to repeat it");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const result: RunResult = {
		...slot,
		applicable: true,
		status: "running",
		startedAt: new Date().toISOString(),
		agentElapsedMs: null,
		userElapsedMs: null,
		validatedElapsedMs: null,
		checkPass: null,
		timedOut: false,
		error: null,
		turnExitCodes: [],
		requestCount: 0,
		sessionFile: null,
		peakSampledTreeRssBytes: null,
	};
	writeJson(join(directory, "result.json"), result);
	const trace = new Trace(directory, slot),
		setup = trace.start("run.setup");
	if (item.id === "H03-dispatch" && slot.variantId === "prime-rust") {
		trace.discard(setup);
		result.applicable = false;
		result.status = "completed";
		trace.unavailable(
			"host.command_dispatch",
			"not_applicable",
			"Pinned native CLI exposes ipython only; executing shell via the runtime would change this host-only workload",
		);
		writeJson(join(directory, "result.json"), result);
		return result;
	}
	const project = join(directory, "project"),
		agentDir = join(directory, "agent"),
		workspace = join(directory, "runtime-workspace");
	const variant = manifest.variants.find((value) => value.id === slot.variantId);
	if (!variant) throw new Error("Variant missing from manifest");
	const env = cleanEnvironment({
		...prepared.env,
		TMPDIR: "/tmp",
		PRIME_AGENT_CODING_AGENT_DIR: agentDir,
		PRIME_AGENT_KERNEL_VENV: join(prepared.variants[0].sourceRoot, `../${slot.variantId}-venv`),
		WASMEDGE_AGENT_CODING_AGENT_DIR: agentDir,
		PI_SKIP_VERSION_CHECK: "1",
		PI_PACKAGE_DIR: slot.variantId === "prime-rust" ? variant.sourceRoot : undefined,
		CARGO_TARGET_DIR: join(directory, "project-target"),
		CARGO_BUILD_BUILD_DIR: join(directory, "project-target"),
		...(item.workload
			? { OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1", NUMEXPR_NUM_THREADS: "1" }
			: {}),
	});
	captureCargo(trace, manifest.variants.find((value) => isWasmVariant(value.id))?.sourceRoot ?? resolve("."), env);
	if (manifest.profileCommands)
		env.PATH = profileCommands(
			directory,
			manifest.variants.find((value) => isWasmVariant(value.id))?.sourceRoot ?? resolve("."),
			env,
		);
	let daemon: OwnedProcess | undefined,
		socket: string | undefined,
		gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
	const tools = new Map<string, StopSpan>();
	let lastToolEnded: bigint | null = null;
	let marker = "";
	let abortTimer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	try {
		fixture(item, project);
		if (item.workload) {
			const stopFixture = trace.start("task.fixture_generate", {
				kind: item.workload.kind,
				scale: item.workload.scale,
			});
			const generated = generateFixture(
				project,
				join(directory, "oracle"),
				item.workload,
				(manifest.seed + Math.imul(slot.repetition, 2654435761)) >>> 0,
			);
			stopFixture();
			trace.event("workload_fixture", { ...generated, oracleVisibility: "host-only-outside-guest-preopens" });
		}
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		if (isWasmVariant(slot.variantId))
			writeJson(join(agentDir, "settings.json"), {
				rustCell: { runtimeMode: variant.runtimeMode ?? "interpreter" },
			});
		mkdirSync(workspace, { recursive: true, mode: 0o700 });
		setup();
		const validated = trace.start("run.validated_elapsed", { boundary: "startup-through-external-checker" }),
			user = trace.start("run.user_elapsed", { includesStartup: true }),
			started = performance.now(),
			deadline = Date.now() + item.taskBudgetMs;
		if (item.lane === "runtime") {
			const task = trace.start("task.agent_elapsed", { boundary: "direct-runtime-start-to-final-oracle" });
			const workers = Number(item.parameters.workers ?? 1);
			const passes = await Promise.all(
				Array.from({ length: workers }, async (_, index) => {
					const workerProject = workers === 1 ? project : join(directory, `project-${index}`),
						workerWorkspace = workers === 1 ? workspace : join(directory, `workspace-${index}`);
					if (workers !== 1) {
						fixture(item, workerProject);
						mkdirSync(workerWorkspace, { recursive: true });
					}
					return directRuntime(
						prepared,
						slot.variantId,
						item,
						trace,
						env,
						workerProject,
						workerWorkspace,
						deadline,
					);
				}),
			);
			result.checkPass = passes.every(Boolean);
			result.timedOut = trace.spans.some((s) => s.name === "cell.roundtrip" && s.outcome === "timeout");
			result.agentElapsedMs = task(result.timedOut ? "timeout" : result.checkPass ? "ok" : "error").durationMs;
		} else {
			controller = new AbortController();
			abortTimer = setTimeout(() => controller?.abort(), Math.max(1, deadline - Date.now()));
			gateway = await startGateway({
				trace,
				modelId: manifest.provider?.modelId ?? "replay-fixed-v1",
				provider: item.lane === "end-to-end" ? manifest.provider : null,
				replay: item.replay?.[slot.variantId],
				limit: manifest.requestLimitPerRun,
				signal: controller.signal,
			});
			env.BENCH_GATEWAY_TOKEN = gateway.token;
			writeJson(
				join(agentDir, "models.json"),
				modelsConfig(
					gateway.baseUrl,
					manifest.provider?.modelId ?? "replay-fixed-v1",
					manifest.provider?.maxTokens,
					item.lane === "end-to-end" ? manifest.provider?.api : undefined,
				),
			);
			const socketDir = mkdtempSync("/tmp/wa-bench-");
			socket = join(socketDir, "d.sock");
			writeJson(join(directory, "owned-processes.json"), { socket, ownedDirectory: socketDir });
			const baseArgs = [
				...variant.args,
				"--provider",
				"benchmark",
				"--model",
				manifest.provider?.modelId ?? "replay-fixed-v1",
				"--thinking",
				"off",
				"--daemon-socket",
				socket,
			];
			// The pinned native CLI always includes its runtime tool. Replay never
			// requests it in H01/H02; record this capability difference explicitly.
			if (slot.variantId !== "prime-rust") {
				if (item.tools === "none") baseArgs.push("--no-builtin-tools");
				else if (item.tools === "bash") baseArgs.push("--tools", "bash");
				else if (item.tools === "runtime-only")
					baseArgs.push("--tools", isWasmVariant(slot.variantId) ? "rust" : "ipython");
			}
			trace.event("host_tool_configuration", {
				requested: item.tools,
				nativeCliToolFilterSupported: slot.variantId !== "prime-rust",
				promptEquivalence: "native-product-context",
			});
			const boot = trace.start("host.daemon_startup");
			daemon = launch(
				variant.command,
				[...baseArgs, "--mode", "daemon"],
				project,
				env,
				join(directory, "daemon.log"),
			);
			await waitDaemon(daemon, socket, Math.min(deadline, Date.now() + 30000));
			boot();
			const task = trace.start("task.agent_elapsed");
			try {
				for (let turn = 0; turn < item.turns.length; turn++) {
					if (Date.now() >= deadline) {
						result.timedOut = true;
						break;
					}
					const turnId = `turn-${turn + 1}`,
						span = trace.start("host.turn", { turnId });
					const args = [...baseArgs, "--mode", "json"];
					if (turn > 0) {
						result.sessionFile = findSession(agentDir);
						if (!result.sessionFile) throw new Error("Multi-turn task has no resumable session");
						args.push("--resume", result.sessionFile);
					}
					const prompt =
						item.lane === "end-to-end" && item.tools === "runtime-only"
							? cellPrompt(item.turns[turn], slot.variantId)
							: item.turns[turn];
					writeJson(join(directory, `${turnId}.input.json`), { prompt, sha256: sha256(prompt) });
					args.push("--print", prompt);
					const turnResult = await timedProcess(
						variant.command,
						args,
						project,
						env,
						join(directory, `${turnId}.jsonl`),
						deadline - Date.now(),
						(line) => {
							let event: unknown;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (!record(event)) return;
							if (
								event.type === "message_end" &&
								record(event.message) &&
								event.message.role === "assistant" &&
								Array.isArray(event.message.content)
							)
								marker += event.message.content
									.flatMap((content) =>
										record(content) && content.type === "text" && typeof content.text === "string"
											? [content.text]
											: [],
									)
									.join("");
							trace.event("agent_event", { turnId, event });
							const toolCallId = String(event.toolCallId ?? "unknown");
							if (event.type === "tool_execution_start")
								tools.set(
									toolCallId,
									trace.start("tool.execution", { toolCallId, toolName: event.toolName, turnId }),
								);
							if (event.type === "tool_execution_end") {
								tools.get(toolCallId)?.(event.isError ? "error" : "ok");
								tools.delete(toolCallId);
								lastToolEnded = process.hrtime.bigint();
								if (["rust", "ipython"].includes(String(event.toolName)) && record(event.result))
									importCell(trace, event.result.details, { toolCallId, cellId: toolCallId, turnId });
							}
							if (event.type === "message_start" && lastToolEnded) {
								trace.event("tool_to_message_start", {
									toolCallId,
									turnId,
									gapMs: Number(process.hrtime.bigint() - lastToolEnded) / 1e6,
									meaning: "client-observed-gap-not-provider-dispatch",
								});
								lastToolEnded = null;
							}
						},
					);
					result.turnExitCodes.push(turnResult.exitCode);
					result.timedOut ||= turnResult.timedOut;
					span(turnResult.timedOut ? "timeout" : turnResult.exitCode === 0 ? "ok" : "error");
					if (turnResult.exitCode !== 0) break;
				}
			} finally {
				if (abortTimer) clearTimeout(abortTimer);
				result.requestCount = gateway.requestCount();
				result.agentElapsedMs = task(result.timedOut ? "timeout" : "ok").durationMs;
			}
			result.sessionFile = findSession(agentDir);
			if (item.check.kind === "marker")
				result.checkPass =
					marker.includes(item.check.value) &&
					result.turnExitCodes.every((code) => code === 0) &&
					result.turnExitCodes.length === item.turns.length;
		}
		result.userElapsedMs = user(result.timedOut ? "timeout" : "ok").durationMs ?? performance.now() - started;
		if (item.check.kind === "workload" && item.workload) {
			const check = trace.start("task.check", { checker: "independent-full-output-and-input-integrity" });
			const checked = checkWorkloadTask(project, workloadOracleDirectory(directory), item.workload);
			writeJson(join(directory, "workload-check.json"), checked);
			result.checkPass =
				checked.pass &&
				!result.timedOut &&
				result.turnExitCodes.length === item.turns.length &&
				result.turnExitCodes.every((code) => code === 0);
			check(result.checkPass ? "ok" : "error");
		}
		if (item.check.kind === "existing" && item.taskDir) {
			const check = trace.start("task.check");
			const checked = await timedProcess(
				"bash",
				[join(item.taskDir, "check.sh")],
				project,
				{
					...env,
					PROJECT_DIR: project,
					CARGO_TARGET_DIR: env.CARGO_TARGET_DIR,
					CARGO_BUILD_BUILD_DIR: env.CARGO_BUILD_BUILD_DIR,
				},
				join(directory, "check.log"),
				60000,
			);
			result.checkPass =
				checked.exitCode === 0 &&
				!result.timedOut &&
				result.turnExitCodes.length === item.turns.length &&
				result.turnExitCodes.every((code) => code === 0);
			check(result.checkPass ? "ok" : "error");
		}
		result.validatedElapsedMs = validated(result.checkPass ? "ok" : "error").durationMs;
		result.checkerPass = result.checkPass;
		result.cellContract = auditCellContract(directory, item, slot.variantId);
		if (result.cellContract.status === "violated") result.checkPass = false;
		result.status = "completed";
	} catch (error) {
		setup("error");
		result.timedOut = error instanceof RuntimeDeadlineError;
		result.status = result.timedOut ? "completed" : "infrastructure_error";
		if (result.timedOut) result.checkPass = false;
		result.error = error instanceof Error ? error.message : "Run failed";
		writeJson(join(directory, "failure.json"), { error: result.error, artifactPreserved: true });
	} finally {
		if (abortTimer) clearTimeout(abortTimer);
		controller?.abort();
		const teardown = trace.start("run.teardown");
		try {
			if (daemon && socket) await stopDaemon(daemon, socket);
			await gateway?.close();
			teardown();
		} catch (error) {
			teardown("error");
			if (daemon) await killOwned(daemon);
			await gateway?.close();
			result.status = "infrastructure_error";
			result.error = error instanceof Error ? error.message : "Cleanup failed";
		}
		for (const stop of tools.values()) stop(result.timedOut ? "timeout" : "error");
		result.cargoCapture = importCargo(trace);
		if (existsSync(join(directory, "aot-commands.jsonl"))) result.aotCapture = importCargo(trace, "aot");
		if (existsSync(join(directory, "native-commands.jsonl")))
			importCommands(trace, join(directory, "native-commands.jsonl"));
		if (
			isWasmVariant(slot.variantId) &&
			item.lane === "end-to-end" &&
			!trace.spans.some((span) => span.name === "cell.compile")
		)
			trace.unavailable(
				"cell.compile",
				"not_run",
				"Native model trajectory used no Rust cell tool; inspect tool.execution and raw tool arguments",
			);
		for (const phase of [
			"host.prompt_build",
			"host.result_pack",
			"host.transcript_append",
			"cell.runtime_launch",
			"cell.exit_drain",
			"compiler.typecheck",
			"compiler.codegen",
			"compiler.link",
			"resource.cpu_user",
			"resource.cpu_system",
			"resource.peak_tree_rss",
		])
			trace.unavailable(
				phase,
				"missing",
				"No internal boundary or exact OS accounting hook in pinned implementation; no wall-time inference",
			);
		trace.finishIncomplete(
			result.timedOut ? "timeout" : result.status === "infrastructure_error" ? "error" : "unknown",
		);
		writeJson(join(directory, "result.json"), result);
	}
	return result;
}

export async function runPlan(root: string, directory: string): Promise<void> {
	const manifest = readJson(join(directory, "manifest.json")) as Manifest,
		prepared = readJson(join(directory, "prepared.json")) as Prepared;
	if (hashTree(join(root, "poc/bench/three-way")) !== manifest.collectorSourceHash)
		throw new Error("Collector changed since planning; create a new immutable plan");
	for (const variant of manifest.variants) {
		const launcher = variant.args[0] ?? variant.command;
		if (
			sha256(readFileSync(launcher)) !== variant.launcherHash ||
			hashTree(
				isWasmVariant(variant.id) ? join(variant.sourceRoot, "packages/coding-agent") : variant.sourceRoot,
			) !== variant.inputsHash
		)
			throw new Error(`Variant sources/build changed: ${variant.id}; prepare and plan again`);
	}
	for (const item of manifest.cases) {
		if (item.taskDir && hashTree(item.taskDir) !== item.parameters.fixtureHash)
			throw new Error("Task snapshot changed");
		if (sha256(JSON.stringify(item)) !== manifest.runs.find((slot) => slot.caseId === item.id)?.caseHash)
			throw new Error("Case changed since planning");
	}
	let failures = 0;
	for (const [index, slot] of manifest.runs.entries()) {
		const resultPath = join(manifest.root, "runs", slot.runId, "result.json");
		if (existsSync(resultPath)) {
			const previous = readJson(resultPath);
			if (record(previous) && previous.status === "completed") continue;
			throw new Error(`Incomplete slot retained: ${slot.runId}; use a new plan for retries`);
		}
		const item = manifest.cases.find((value) => value.id === slot.caseId);
		if (!item) throw new Error("Case absent");
		console.log(`[${index + 1}/${manifest.runs.length}] ${slot.caseId} ${slot.variantId}`);
		const result = await runOne(manifest, prepared, slot, item);
		console.log(
			JSON.stringify({
				status: result.status,
				checkPass: result.checkPass,
				agentElapsedMs: result.agentElapsedMs,
				requestCount: result.requestCount,
				error: result.error,
			}),
		);
		if (result.status === "infrastructure_error") failures++;
	}
	if (failures) throw new Error(`${failures} infrastructure failures retained; all planned slots were attempted`);
}
