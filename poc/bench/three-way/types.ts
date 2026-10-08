export const VARIANTS = ["prime-ts", "prime-rust", "wasmedge", "wasmedge-aot"] as const;
export type VariantId = (typeof VARIANTS)[number];
export const isWasmVariant = (id: string): boolean => id === "wasmedge" || id === "wasmedge-aot";
export type Lane = "host" | "runtime" | "end-to-end";
export type MeasurementState = "measured" | "not_applicable" | "not_run" | "missing" | "incomplete";
export type Outcome =
	| "ok"
	| "compile_error"
	| "error"
	| "timeout"
	| "aborted"
	| "not_applicable"
	| "not_run"
	| "unknown";

export interface Variant {
	id: VariantId;
	baseRevision: string;
	sourceRoot: string;
	command: string;
	args: string[];
	inputsHash: string;
	launcherHash: string;
	runtimeMode?: "interpreter" | "aot";
}

export interface Provider {
	api: "openai-completions";
	baseUrl: string;
	modelId: string;
	modelIdentity: "advertised-id-not-independent-revision-verification";
	contextWindow: number;
	maxTokens: number;
}

export interface Span {
	schemaVersion: 1;
	recordId: string;
	runId: string;
	variantId: VariantId;
	benchmarkId: string;
	agentId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	processId: number | null;
	clockId: string | null;
	startMonoNs: string | null;
	endMonoNs: string | null;
	durationMs: number | null;
	measurementState: MeasurementState;
	outcome: Outcome;
	reason?: string;
	turnId?: string | null;
	requestId?: string | null;
	requestAttempt?: number | null;
	toolCallId?: string | null;
	cellId?: string | null;
	commandId?: string | null;
	repairChainId?: string | null;
	attributes: Record<string, unknown>;
	counters: Record<string, number | null>;
}

export interface ReplayStep {
	text?: string;
	reasoning?: string;
	tool?: { name: string; arguments: Record<string, unknown> };
	delayMs?: number;
	chunkBytes?: number;
}

export interface Case {
	id: string;
	lane: Lane;
	scale: string;
	cacheCondition: string;
	turns: string[];
	taskDir?: string;
	taskBudgetMs: number;
	fixture: Record<string, string>;
	replay?: Partial<Record<VariantId, ReplayStep[]>>;
	tools?: "none" | "bash" | "native" | "runtime-only";
	check: { kind: "existing" } | { kind: "file"; path: string; content: string } | { kind: "marker"; value: string };
	expectedCellOutcomes?: string[];
	parameters: Record<string, unknown>;
	runtime?: Partial<Record<VariantId, RuntimeStep[]>>;
}

export interface RuntimeStep {
	op: "execute" | "snapshot" | "restore" | "restart" | "clear-target";
	code?: string;
	lib?: { path: string; content: string }[];
	abortAfterMs?: number;
	expectedStatus: string[];
	stdoutIncludes?: string;
}

export interface RunSlot {
	runId: string;
	variantId: VariantId;
	caseId: string;
	repetition: number;
	caseHash: string;
	modelId: string;
}

export interface Manifest {
	version: 1;
	createdAt: string;
	seed: number;
	root: string;
	provider: Provider | null;
	variants: Variant[];
	cases: Case[];
	runs: RunSlot[];
	requestLimitPerRun: number;
	collectorSourceHash: string;
	profileCommands: boolean;
}

export interface RunResult extends RunSlot {
	applicable: boolean;
	status: "planned" | "running" | "completed" | "infrastructure_error";
	startedAt: string | null;
	agentElapsedMs: number | null;
	userElapsedMs: number | null;
	validatedElapsedMs?: number | null;
	cargoCapture?: CargoCapture;
	aotCapture?: CargoCapture;
	checkPass: boolean | null;
	timedOut: boolean;
	error: string | null;
	turnExitCodes: (number | null)[];
	requestCount: number;
	sessionFile: string | null;
	peakSampledTreeRssBytes: number | null;
	checkerPass?: boolean | null;
	cellContract?: CellContractAudit;
}

export interface CargoCapture {
	version: 1;
	complete: boolean;
	clockVerified: boolean;
	startedCommands: number;
	completedCommands: number;
	errors: string[];
	method: "cargo-path-and-runtime-override" | "aot-runtime-override";
}

export interface CellContractAudit {
	status: "compliant" | "violated" | "not-controlled" | "not-applicable";
	expectedTool: "rust" | "ipython";
	observedTools: string[];
	cellCalls: number;
	successfulCells: number;
	cellsPerTurn: Record<string, number>;
	violations: string[];
	sources: { toolCallId: string; turnId: string; path: string; sha256: string; bytes: number }[];
	sourceScreening: string;
}
