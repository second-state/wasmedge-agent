/** rust-cell runtime: WasmEdge-sandboxed Rust cell execution replacing the
 * IPython kernel (DESIGN.md §2). The provisioner mirrors the lifecycle shape
 * the kernel provisioner had so AgentSession wiring stays small. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostRequestHandlers } from "../host-bridge/types.js";
import { loadHarnessState } from "../refinement/refinement.js";
import { BridgeServer } from "./bridge-server.js";
import { cargoEnvironment } from "./cargo-environment.js";
import { CellRunner } from "./cell-runner.js";
import { createDependencyHandler } from "./dependencies.js";
import { readCellDependencies, workspaceDependencies } from "./dependency-catalog.js";
import { recoverDependencyUpdate } from "./dependency-transaction.js";
import {
	configurePreludeExtra,
	normalizePreludeExtra,
	type PreludeExtra,
	preludeConfigurationHash,
} from "./prelude-extra.js";
import { type CellResourceLimits, validateCellResourceLimits } from "./resource-limits.js";
import { SkillValidation } from "./skill-validation.js";
import { ensureTemplateReady, resolveToolchain, rustcVersion, type ToolchainInfo } from "./toolchain.js";
import {
	listPersistentState,
	type PersistentStateListing,
	type RustSkillMount,
	resolveTemplateDir,
	syncRustSkills,
} from "./workspace.js";
import { WorkspaceHistory } from "./workspace-history.js";
import { normalizeWorkspaceWritePolicy, type WorkspaceWritePolicy } from "./workspace-policy.js";
import { withInheritedSkills } from "./workspace-snapshot.js";
import { prepareVersionedWorkspace, recoverWorkspaceUpgrade } from "./workspace-version.js";

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
export type { WorkspaceWritePolicy } from "./workspace-policy.js";

export interface RustCellProvisionerOptions extends CellResourceLimits {
	/** Guest /workspace access; defaults to rw. Fixed until the runtime is rebuilt. */
	workspaceWritePolicy?: WorkspaceWritePolicy;
	/** Project directory mounted at /workspace. */
	cwd: string;
	/** Persistent workspace dir (session artifacts); temp dir when omitted. */
	workspaceDir?: string;
	/** Frozen parent workspace, captured when a child was spawned. */
	initialWorkspaceDir?: string;
	/** Per-cell budget in ms (compile + run). */
	cellTimeoutMs?: number;
	/** User-selected crates.io dependencies, fixed for the provisioner's lifetime. */
	preludeExtra?: PreludeExtra[];
	/** Additional host requests; deps.add is always provided by the runtime. */
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
	private readonly options: RustCellProvisionerOptions & { workspaceWritePolicy: WorkspaceWritePolicy };
	private starting: Promise<CellRunner> | undefined;
	private runner: CellRunner | undefined;
	private toolchainInfo: ToolchainInfo | undefined;
	private workspace: string | undefined;
	private bridgeServer: BridgeServer | undefined;
	private skillValidation: SkillValidation | undefined;

	constructor(options: RustCellProvisionerOptions) {
		validateCellResourceLimits(options);
		this.options = {
			...options,
			preludeExtra: normalizePreludeExtra(options.preludeExtra),
			workspaceWritePolicy: normalizeWorkspaceWritePolicy(options.workspaceWritePolicy),
		};
	}

	get workspaceWritePolicy(): WorkspaceWritePolicy {
		return this.options.workspaceWritePolicy;
	}

	get hasRunner(): boolean {
		return this.runner !== undefined;
	}

	/** An on-disk workspace can be listed before runtime/toolchain initialization. */
	get hasWorkspace(): boolean {
		return this.existingWorkspaceDir !== undefined;
	}

	private get existingWorkspaceDir(): string | undefined {
		const dir = this.workspace ?? this.options.workspaceDir;
		return dir && existsSync(join(dir, "Cargo.toml")) ? dir : undefined;
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
		await this.skillValidation!.test(reference, signal);
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
		recoverWorkspaceUpgrade(this.workspace);
		recoverDependencyUpdate(this.workspace);
		const recordSource = existsSync(join(this.workspace, "Cargo.toml"))
			? this.workspace
			: (this.options.initialWorkspaceDir ?? this.workspace);
		const extras = workspaceDependencies(this.options.preludeExtra!, readCellDependencies(recordSource));
		prepareVersionedWorkspace(this.workspace, {
			templateDir,
			initialWorkspaceDir: this.options.initialWorkspaceDir,
			rustcVersion: rustcVersion(
				this.toolchainInfo.cargoBin,
				existsSync(this.workspace) ? this.workspace : templateDir,
			),
			wasmedgeVersion: this.toolchainInfo.wasmedgeVersion,
			configurationHash: preludeConfigurationHash(extras),
			configure: (workspace) => {
				const skills = withInheritedSkills(workspace, this.options.rustSkills ?? []);
				for (const extra of extras) {
					if (skills.some((skill) => skill.crateName === extra.name.replaceAll("-", "_"))) {
						throw new Error(`preludeExtra crate conflicts with a mounted skill: ${extra.name}`);
					}
				}
				onProgress?.("Preparing configured prelude dependencies...");
				configurePreludeExtra(workspace, extras, this.toolchainInfo!.cargoBin);
				syncRustSkills(workspace, skills);
			},
			validate: (workspace) => {
				execFileSync(this.toolchainInfo!.cargoBin, ["build", "--release", "--offline", "-p", "cell"], {
					cwd: workspace,
					env: cargoEnvironment(),
					stdio: "pipe",
					timeout: 300_000,
				});
			},
			onProgress,
		});
		const rustSkills = withInheritedSkills(this.workspace, this.options.rustSkills ?? []);
		for (const extra of extras) {
			if (rustSkills.some((skill) => skill.crateName === extra.name.replaceAll("-", "_"))) {
				throw new Error(`preludeExtra crate conflicts with a mounted skill: ${extra.name}`);
			}
		}
		if (rustSkills.length > 0 || existsSync(join(this.workspace, ".skills-hash"))) {
			onProgress?.("Mounting rust skills...");
			const sync = syncRustSkills(this.workspace, rustSkills, { cargoBin: this.toolchainInfo.cargoBin });
			for (const failure of sync.failed) {
				this.options.onDiagnostic?.(
					`rust skill "${failure.name}" failed to compile and was unmounted: ${failure.message}`,
				);
			}
		}
		const history = this.options.workspaceDir ? new WorkspaceHistory(this.workspace) : undefined;
		history?.ensure();
		if (!this.bridgeServer) {
			this.bridgeServer = new BridgeServer({
				handlers: {
					...this.options.hostHandlers,
					"deps.add": createDependencyHandler({
						workspace: this.workspace,
						template: templateDir,
						cargoBin: this.toolchainInfo.cargoBin,
						configured: this.options.preludeExtra!,
						timeoutMs: this.options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS,
						history,
					}),
				},
				onDiagnostic: this.options.onDiagnostic,
			});
		}
		this.skillValidation = new SkillValidation({
			workspaceDir: this.workspace,
			cargoBin: this.toolchainInfo.cargoBin,
			wasmedgeBin: this.toolchainInfo.wasmedgeBin,
			timeoutMs: this.options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS,
			cellGasLimit: this.options.cellGasLimit,
			cellMemoryPageLimit: this.options.cellMemoryPageLimit,
		});
		return new CellRunner({
			workspaceWritePolicy: this.workspaceWritePolicy,
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
			validateSkills: (signal, timeoutMs) => {
				const references = [this.options.harnessDir, this.options.globalHarnessDir].flatMap((dir) =>
					dir ? Object.values(loadHarnessState(dir).entries.skill).map((entry) => entry.reference) : [],
				);
				return this.skillValidation!.revalidate(references, signal, timeoutMs);
			},
		});
	}

	/** Fire-and-forget warmup so the first cell skips toolchain checks. */
	prewarm(): void {
		void this.ensure().catch(() => {});
	}

	/** Read current state without provisioning; restored workspaces need no runner. */
	listState(): PersistentStateListing {
		const workspace = this.existingWorkspaceDir;
		if (!workspace) return { stateKeys: [], blobNames: [], libFunctions: [], libTypes: [] };
		return listPersistentState(workspace);
	}

	async dispose(): Promise<void> {
		this.runner = undefined;
		this.starting = undefined;
		const bridge = this.bridgeServer;
		this.bridgeServer = undefined;
		await bridge?.dispose();
	}
}
