/** rust-cell runtime: WasmEdge-sandboxed Rust cell execution replacing the
 * IPython kernel (DESIGN.md §2). The provisioner mirrors the lifecycle shape
 * the kernel provisioner had so AgentSession wiring stays small. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostRequestHandlers } from "../host-bridge/types.js";
import { BridgeServer } from "./bridge-server.js";
import { CellRunner } from "./cell-runner.js";
import { type CellResourceLimits, validateCellResourceLimits } from "./resource-limits.js";
import { testRustSkill } from "./skill-tests.js";
import { ensureTemplateReady, resolveToolchain, rustcVersion, type ToolchainInfo } from "./toolchain.js";
import {
	listPersistentState,
	type PersistentStateListing,
	type RustSkillMount,
	resolveTemplateDir,
	syncRustSkills,
} from "./workspace.js";
import { WorkspaceHistory } from "./workspace-history.js";
import { withInheritedSkills } from "./workspace-snapshot.js";
import { prepareVersionedWorkspace } from "./workspace-version.js";

export {
	BRIDGE_PROTOCOL_VERSION,
	type BridgeCellScope,
	type BridgeEmitSinks,
	BridgeServer,
	type BridgeServerOptions,
} from "./bridge-server.js";
export { CellRunner, composeToolText } from "./cell-runner.js";
export type { CellResourceLimits } from "./resource-limits.js";
export {
	ensureTemplateReady,
	isTemplateVendored,
	isTemplateWarm,
	resolveToolchain,
	type ToolchainInfo,
	vendorTemplate,
	warmTemplate,
} from "./toolchain.js";
export type {
	CellInput,
	CellResult,
	CellStatus,
	LibFile,
	PerCallOptions,
	RunnerOptions,
} from "./types.js";
export { MAX_OUTPUT_CHARS } from "./types.js";
export {
	ensureWorkspaceAt,
	listPersistentState,
	type PersistentStateListing,
	type RustSkillMount,
	removeWorkspace,
	resolveTemplateDir,
	type SyncRustSkillsResult,
	syncRustSkills,
} from "./workspace.js";

export interface RustCellProvisionerOptions extends CellResourceLimits {
	/** Project directory mounted at /workspace. */
	cwd: string;
	/** Persistent workspace dir (session artifacts); temp dir when omitted. */
	workspaceDir?: string;
	/** Frozen parent workspace, captured when a child was spawned. */
	initialWorkspaceDir?: string;
	/** Per-cell budget in ms (compile + run). */
	cellTimeoutMs?: number;
	/** Host request registry; when set, cells run with a live bridge. */
	hostHandlers?: HostRequestHandlers;
	/** Extra WASI env vars for every cell (e.g. RLM_DEPTH). */
	cellEnv?: Record<string, string>;
	/** Rust skill crates to mount as agent_lib::skills::* (DESIGN.md §4.1). */
	rustSkills?: RustSkillMount[];
	/** Session-local harness state dir (rlm::harness::local, DESIGN.md §4.3). */
	harnessDir?: string;
	/** Global harness state dir (rlm::harness::global). */
	globalHarnessDir?: string;
	/** Sink for bridge protocol diagnostics. */
	onDiagnostic?: (message: string) => void;
}

const DEFAULT_CELL_TIMEOUT_MS = 120_000;

/** Lazy, memoized runtime provisioning: toolchain checks, template warmup,
 * workspace clone, runner construction. Failure clears the memo so the next
 * call retries (same contract the kernel provisioner had). */
export class RustCellProvisioner {
	private readonly options: RustCellProvisionerOptions;
	private starting: Promise<CellRunner> | undefined;
	private runner: CellRunner | undefined;
	private toolchainInfo: ToolchainInfo | undefined;
	private workspace: string | undefined;
	private bridgeServer: BridgeServer | undefined;

	constructor(options: RustCellProvisionerOptions) {
		validateCellResourceLimits(options);
		this.options = { ...options };
	}

	get hasRunner(): boolean {
		return this.runner !== undefined;
	}

	get workspaceDir(): string | undefined {
		return this.workspace;
	}

	get toolchain(): ToolchainInfo | undefined {
		return this.toolchainInfo;
	}

	get bridge(): BridgeServer | undefined {
		return this.bridgeServer;
	}

	async testSkill(reference: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		await this.ensure();
		await testRustSkill(reference, {
			workspaceDir: this.workspace!,
			cargoBin: this.toolchainInfo!.cargoBin,
			wasmedgeBin: this.toolchainInfo!.wasmedgeBin,
			timeoutMs: this.options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS,
			cellGasLimit: this.options.cellGasLimit,
			cellMemoryPageLimit: this.options.cellMemoryPageLimit,
			signal,
		});
	}

	ensure(onProgress?: (message: string) => void): Promise<CellRunner> {
		if (this.runner) return Promise.resolve(this.runner);
		if (this.starting) return this.starting;
		this.starting = this.start(onProgress).then(
			(runner) => {
				this.runner = runner;
				this.starting = undefined;
				return runner;
			},
			(error) => {
				this.starting = undefined;
				throw error;
			},
		);
		return this.starting;
	}

	private async start(onProgress?: (message: string) => void): Promise<CellRunner> {
		onProgress?.("Checking Rust/WasmEdge toolchain...");
		this.toolchainInfo = resolveToolchain();
		ensureTemplateReady(this.toolchainInfo.cargoBin, onProgress);
		onProgress?.("Preparing the cell workspace...");
		this.workspace = this.options.workspaceDir ?? mkdtempSync(join(tmpdir(), "wasmedge-agent-ws-"));
		const templateDir = resolveTemplateDir();
		prepareVersionedWorkspace(this.workspace, {
			templateDir,
			initialWorkspaceDir: this.options.initialWorkspaceDir,
			rustcVersion: rustcVersion(
				this.toolchainInfo.cargoBin,
				existsSync(this.workspace) ? this.workspace : templateDir,
			),
			wasmedgeVersion: this.toolchainInfo.wasmedgeVersion,
			configure: (workspace) => {
				syncRustSkills(workspace, withInheritedSkills(workspace, this.options.rustSkills ?? []));
			},
			validate: (workspace) => {
				execFileSync(this.toolchainInfo!.cargoBin, ["build", "--release", "--offline", "-p", "cell"], {
					cwd: workspace,
					stdio: "pipe",
					timeout: 300_000,
				});
			},
			onProgress,
		});
		const rustSkills = withInheritedSkills(this.workspace, this.options.rustSkills ?? []);
		if (rustSkills.length > 0 || existsSync(join(this.workspace, ".skills-hash"))) {
			onProgress?.("Mounting rust skills...");
			const sync = syncRustSkills(this.workspace, rustSkills, { cargoBin: this.toolchainInfo.cargoBin });
			for (const failure of sync.failed) {
				this.options.onDiagnostic?.(
					`rust skill "${failure.name}" failed to compile and was unmounted: ${failure.message}`,
				);
			}
		}
		if (this.options.hostHandlers && !this.bridgeServer) {
			this.bridgeServer = new BridgeServer({
				handlers: this.options.hostHandlers,
				onDiagnostic: this.options.onDiagnostic,
			});
		}
		const history = this.options.workspaceDir ? new WorkspaceHistory(this.workspace) : undefined;
		history?.ensure();
		return new CellRunner({
			cwd: this.options.cwd,
			workspaceDir: this.workspace,
			wasmedgeBin: this.toolchainInfo.wasmedgeBin,
			cargoBin: this.toolchainInfo.cargoBin,
			cellTimeoutMs: this.options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS,
			cellGasLimit: this.options.cellGasLimit,
			cellMemoryPageLimit: this.options.cellMemoryPageLimit,
			bridge: this.bridgeServer,
			cellEnv: this.options.cellEnv,
			harnessDir: this.options.harnessDir,
			globalHarnessDir: this.options.globalHarnessDir,
			history,
		});
	}

	/** Fire-and-forget warmup so the first cell skips toolchain checks. */
	prewarm(): void {
		void this.ensure().catch(() => {});
	}

	/** State listing for compaction/resume notices; empty when never started. */
	listState(): PersistentStateListing {
		if (!this.workspace) return { stateKeys: [], blobNames: [], libFunctions: [] };
		return listPersistentState(this.workspace);
	}

	async dispose(): Promise<void> {
		this.runner = undefined;
		this.starting = undefined;
		const bridge = this.bridgeServer;
		this.bridgeServer = undefined;
		await bridge?.dispose();
	}
}
