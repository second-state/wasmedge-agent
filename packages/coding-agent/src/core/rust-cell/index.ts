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
import { type CargoSandbox, cargoCommand, normalizeCargoSandbox } from "./cargo-sandbox.js";
import { CellRunner } from "./cell-runner.js";
import { createDependencyHandler } from "./dependencies.js";
import { readCellDependencies, workspaceDependencies } from "./dependency-catalog.js";
import { recoverDependencyUpdate } from "./dependency-transaction.js";
import { normalizeLibraryTestGate } from "./library-tests.js";
import {
	configurePreludeExtra,
	normalizePreludeExtra,
	type PreludeExtra,
	preludeConfigurationHash,
} from "./prelude-extra.js";
import { type ProcessLimits, runtimeProcessLimits } from "./process-limits.js";
import { type CellResourceLimits, validateCellResourceLimits } from "./resource-limits.js";
import { createRustdocHandler } from "./rustdoc.js";
import { normalizeRustdocToolchain } from "./rustdoc-cache.js";
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
export type { CargoSandbox } from "./cargo-sandbox.js";
export { CellRunner, composeToolText } from "./cell-runner.js";
export type { ProcessLimits } from "./process-limits.js";
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
	/** Linux Bubblewrap sandbox for runtime Cargo; defaults to off. */
	cargoSandbox?: CargoSandbox;
	/** Installed rustup toolchain for on-demand rustdoc JSON; disabled by default. */
	rustdocToolchain?: string | null;
	/** Test proposed lib edits in WASI before applying them; defaults to false. */
	libraryTestGate?: boolean;
	/** Wait for the previous runtime to release this workspace before provisioning. */
	beforeStart?: Promise<void>;
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
	private lifetime = new AbortController();
	private stopping: Promise<void> | undefined;
	private readonly pendingSkillTests = new Set<Promise<void>>();

	constructor(options: RustCellProvisionerOptions) {
		validateCellResourceLimits(options);
		this.options = {
			...options,
			cargoSandbox: normalizeCargoSandbox(options.cargoSandbox),
			processLimits: runtimeProcessLimits(options.processLimits, options.cargoSandbox),
			rustdocToolchain: normalizeRustdocToolchain(options.rustdocToolchain),
			libraryTestGate: normalizeLibraryTestGate(options.libraryTestGate),
			preludeExtra: normalizePreludeExtra(options.preludeExtra),
			workspaceWritePolicy: normalizeWorkspaceWritePolicy(options.workspaceWritePolicy),
		};
		// A lazy runtime may not start until long after its predecessor closes.
		// Observe rejection now; ensure() still propagates it to the caller.
		void options.beforeStart?.catch(() => {});
	}

	get workspaceWritePolicy(): WorkspaceWritePolicy {
		return this.options.workspaceWritePolicy;
	}

	get cargoSandbox(): CargoSandbox {
		return this.options.cargoSandbox ?? "off";
	}

	get processLimits(): Readonly<ProcessLimits> | undefined {
		return this.options.processLimits ?? undefined;
	}

	get libraryTestGate(): boolean {
		return this.options.libraryTestGate === true;
	}

	get rustdocToolchain(): string | undefined {
		return this.options.rustdocToolchain ?? undefined;
	}

	get hasRunner(): boolean {
		return this.runner !== undefined && !this.stopping;
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
		await this.stopping;
		const lifetime = this.lifetime.signal;
		const combined = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
		combined.throwIfAborted();
		await this.ensure();
		combined.throwIfAborted();
		const testing = this.skillValidation!.test(reference, combined);
		this.pendingSkillTests.add(testing);
		try {
			await testing;
		} finally {
			this.pendingSkillTests.delete(testing);
		}
	}

	ensure(onProgress?: (message: string) => void): Promise<CellRunner> {
		if (this.stopping) return this.stopping.then(() => this.ensure(onProgress));
		if (this.runner) return Promise.resolve(this.runner);
		if (this.starting) return this.starting;
		const lifetime = this.lifetime.signal;
		this.starting = Promise.resolve(this.options.beforeStart)
			.then(() => {
				lifetime.throwIfAborted();
				return this.start(onProgress);
			})
			.then(async (runner) => {
				this.runner = runner;
				if (lifetime.aborted) {
					await runner.dispose();
					lifetime.throwIfAborted();
				}
				return runner;
			})
			.finally(() => {
				this.starting = undefined;
			});
		return this.starting;
	}

	private async start(onProgress?: (message: string) => void): Promise<CellRunner> {
		onProgress?.("Checking Rust/WasmEdge toolchain...");
		this.toolchainInfo = resolveToolchain();
		ensureTemplateReady(this.toolchainInfo.cargoBin, onProgress, this.cargoSandbox, this.options.processLimits);
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
				configurePreludeExtra(
					workspace,
					extras,
					this.toolchainInfo!.cargoBin,
					this.cargoSandbox,
					this.options.processLimits,
				);
				syncRustSkills(workspace, skills, {
					cargoBin: this.toolchainInfo!.cargoBin,
					cargoSandbox: this.cargoSandbox,
					processLimits: this.options.processLimits,
				});
			},
			validate: (workspace) => {
				const command = cargoCommand(
					this.toolchainInfo!.cargoBin,
					["build", "--release", "--offline", "-p", "cell"],
					{ cwd: workspace, cargoSandbox: this.cargoSandbox, processLimits: this.options.processLimits },
				);
				execFileSync(command.bin, command.args, {
					cwd: workspace,
					env: command.env,
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
			const sync = syncRustSkills(this.workspace, rustSkills, {
				cargoBin: this.toolchainInfo.cargoBin,
				cargoSandbox: this.cargoSandbox,
				processLimits: this.options.processLimits,
			});
			for (const failure of sync.failed) {
				this.options.onDiagnostic?.(`rust skill "${failure.name}" was unmounted: ${failure.message}`);
			}
		}
		const history = this.options.workspaceDir ? new WorkspaceHistory(this.workspace) : undefined;
		history?.ensure();
		if (!this.bridgeServer) {
			this.bridgeServer = new BridgeServer({
				handlers: {
					...this.options.hostHandlers,
					"api.describe": createRustdocHandler({
						workspace: this.workspace,
						cargoSandbox: this.cargoSandbox,
						processLimits: this.options.processLimits,
						toolchain: this.options.rustdocToolchain,
						timeoutMs: this.options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS,
					}),
					"deps.add": createDependencyHandler({
						workspace: this.workspace,
						cargoSandbox: this.cargoSandbox,
						processLimits: this.options.processLimits,
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
			cargoSandbox: this.cargoSandbox,
			processLimits: this.options.processLimits,
			cargoBin: this.toolchainInfo.cargoBin,
			wasmedgeBin: this.toolchainInfo.wasmedgeBin,
			timeoutMs: this.options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS,
			cellGasLimit: this.options.cellGasLimit,
			cellMemoryPageLimit: this.options.cellMemoryPageLimit,
		});
		return new CellRunner({
			libraryTestGate: this.libraryTestGate,
			workspaceWritePolicy: this.workspaceWritePolicy,
			cwd: this.options.cwd,
			workspaceDir: this.workspace,
			cargoSandbox: this.cargoSandbox,
			processLimits: this.options.processLimits,
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

	dispose(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.lifetime.abort(new Error("Rust cell runtime disposed"));
		const runnerStopped = this.runner?.dispose();
		this.stopping = (async () => {
			await this.starting?.catch(() => undefined);
			await this.options.beforeStart;
			await runnerStopped;
			await this.runner?.dispose();
			await Promise.allSettled(this.pendingSkillTests);
			await this.bridgeServer?.dispose();
		})().finally(() => {
			this.runner = undefined;
			this.starting = undefined;
			this.bridgeServer = undefined;
			this.skillValidation = undefined;
			this.lifetime = new AbortController();
			this.stopping = undefined;
		});
		return this.stopping;
	}
}
