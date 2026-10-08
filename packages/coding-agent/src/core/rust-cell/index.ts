/** rust-cell runtime: WasmEdge-sandboxed Rust cell execution replacing the
 * IPython kernel (DESIGN.md §2). The provisioner mirrors the lifecycle shape
 * the kernel provisioner had so AgentSession wiring stays small. */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostRequestHandlers } from "../host-bridge/types.js";
import { loadHarnessState } from "../refinement/refinement.js";
import type { SessionLease } from "../session-lease.js";
import { BridgeServer } from "./bridge-server.js";
import { withBuildPermit } from "./build-gate.js";
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
import { ProvisioningContext } from "./provisioning.js";
import { type RuntimeResourceLimits, validateCellResourceLimits } from "./resource-limits.js";
import { createRustdocHandler } from "./rustdoc.js";
import { normalizeRustdocToolchain } from "./rustdoc-cache.js";
import { SkillValidation } from "./skill-validation.js";
import { ensureTemplateReadyAsync, resolveToolchainAsync, rustcVersionAsync, type ToolchainInfo } from "./toolchain.js";
import {
	listPersistentState,
	type PersistentStateListing,
	type RustSkillMount,
	resolveTemplateDir,
	syncRustSkillsAsync,
} from "./workspace.js";
import { WorkspaceHistory } from "./workspace-history.js";
import { acquireWorkspaceLease } from "./workspace-lease.js";
import { normalizeWorkspaceWritePolicy, type WorkspaceWritePolicy } from "./workspace-policy.js";
import { withInheritedSkills } from "./workspace-snapshot.js";
import { prepareVersionedWorkspaceAsync, recoverWorkspaceUpgrade } from "./workspace-version.js";

export {
	BRIDGE_PROTOCOL_VERSION,
	type BridgeCellScope,
	type BridgeEmitSinks,
	BridgeServer,
	type BridgeServerOptions,
} from "./bridge-server.js";
export type { CargoSandbox } from "./cargo-sandbox.js";
export { CellRunner, composeToolText } from "./cell-runner.js";
export { ProcessResourceGroup } from "./process-group.js";
export type { ProcessLimits } from "./process-limits.js";
export type { CellResourceLimits, RuntimeResourceLimits } from "./resource-limits.js";
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

import { normalizeRustCellRuntimeMode, type RustCellRuntimeMode } from "./runtime-mode.js";

export type { RustCellRuntimeMode } from "./runtime-mode.js";
export type { WorkspaceWritePolicy } from "./workspace-policy.js";

export interface RustCellProvisionerOptions extends RuntimeResourceLimits {
	runtimeMode?: RustCellRuntimeMode;
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
	/** Startup budget including queueing, probes and Cargo; defaults to five minutes. */
	provisionTimeoutMs?: number;
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

export const DEFAULT_CELL_TIMEOUT_MS = 120_000;

/** Lazy, memoized runtime provisioning: toolchain checks, template warmup,
 * workspace clone, runner construction. Failure clears the memo so the next
 * call retries (same contract the kernel provisioner had). */
export class RustCellProvisioner {
	private readonly options: RustCellProvisionerOptions & { workspaceWritePolicy: WorkspaceWritePolicy };
	private starting: Promise<CellRunner> | undefined;
	private provisioning: ProvisioningContext | undefined;
	private runner: CellRunner | undefined;
	private toolchainInfo: ToolchainInfo | undefined;
	private workspace: string | undefined;
	private workspaceLease: SessionLease | undefined;
	private bridgeServer: BridgeServer | undefined;
	private skillValidation: SkillValidation | undefined;
	private lifetime = new AbortController();
	private stopping: Promise<void> | undefined;
	private readonly pendingSkillTests = new Set<Promise<void>>();

	constructor(options: RustCellProvisionerOptions) {
		const timeout = options.provisionTimeoutMs === undefined ? 300_000 : options.provisionTimeoutMs;
		if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
			throw new Error("provisionTimeoutMs must be an integer between 1 and 2147483647");
		}
		validateCellResourceLimits(options);
		runtimeProcessLimits(options.processGroup?.limits, options.cargoSandbox, "rustCell.treeProcessLimits");
		this.options = {
			...options,
			cargoSandbox: normalizeCargoSandbox(options.cargoSandbox),
			processLimits: runtimeProcessLimits(options.processLimits, options.cargoSandbox),
			rustdocToolchain: normalizeRustdocToolchain(options.rustdocToolchain),
			libraryTestGate: normalizeLibraryTestGate(options.libraryTestGate),
			runtimeMode: normalizeRustCellRuntimeMode(options.runtimeMode),
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

	get treeProcessLimits(): Readonly<ProcessLimits> | undefined {
		return this.options.processGroup?.limits;
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
		await this.ensure(undefined, signal);
		const lifetime = this.lifetime.signal;
		const combined = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
		combined.throwIfAborted();
		const testing = this.skillValidation!.test(reference, combined);
		this.pendingSkillTests.add(testing);
		try {
			await testing;
		} finally {
			this.pendingSkillTests.delete(testing);
		}
	}

	/** Callers share one startup attempt. Cancelling any waiter cancels that
	 * attempt (including prewarm); all waiters drain it before a retry. */
	async ensure(onProgress?: (message: string) => void, signal?: AbortSignal): Promise<CellRunner> {
		signal?.throwIfAborted();
		if (this.stopping) {
			// Disposal retains the predecessor barrier even if this caller stops waiting.
			const waiting = new ProvisioningContext(
				signal ?? new AbortController().signal,
				this.options.provisionTimeoutMs ?? 300_000,
			);
			try {
				await waiting.wait(this.stopping);
			} finally {
				waiting.dispose();
			}
			return this.ensure(onProgress, signal);
		}
		if (this.runner) return this.runner;
		if (!this.starting) {
			const context = new ProvisioningContext(this.lifetime.signal, this.options.provisionTimeoutMs ?? 300_000);
			this.provisioning = context;
			this.starting = Promise.resolve()
				.then(async () => {
					await context.wait(Promise.resolve(this.options.beforeStart));
					context.check();
					return this.start(context, onProgress);
				})
				.then(async (runner) => {
					try {
						context.check();
					} catch (error) {
						await runner.dispose();
						await this.bridgeServer?.dispose();
						this.bridgeServer = undefined;
						this.skillValidation = undefined;
						throw error;
					}
					this.runner = runner;
					return runner;
				})
				.catch((error: unknown) => {
					this.workspaceLease?.release();
					this.workspaceLease = undefined;
					throw error;
				})
				.finally(() => {
					context.dispose();
					this.starting = undefined;
					this.provisioning = undefined;
				});
		}
		const context = this.provisioning!;
		const onAbort = () => context.abort(signal!.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await this.starting;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async start(context: ProvisioningContext, onProgress?: (message: string) => void): Promise<CellRunner> {
		onProgress?.("Checking Rust/WasmEdge toolchain...");
		context.check();
		this.toolchainInfo = await resolveToolchainAsync(context);
		await ensureTemplateReadyAsync(
			this.toolchainInfo.cargoBin,
			context,
			onProgress,
			this.cargoSandbox,
			this.options.processLimits,
			this.options.processGroup,
		);
		onProgress?.("Preparing the cell workspace...");
		context.check();
		this.workspace = this.options.workspaceDir ?? this.workspace ?? mkdtempSync(join(tmpdir(), "wasmedge-agent-ws-"));
		this.workspaceLease = await acquireWorkspaceLease(this.workspace, context, true);
		context.check();
		const templateDir = resolveTemplateDir();
		await recoverWorkspaceUpgrade(this.workspace);
		recoverDependencyUpdate(this.workspace);
		const recordSource = existsSync(join(this.workspace, "Cargo.toml"))
			? this.workspace
			: (this.options.initialWorkspaceDir ?? this.workspace);
		const extras = workspaceDependencies(this.options.preludeExtra!, readCellDependencies(recordSource));
		await prepareVersionedWorkspaceAsync(
			this.workspace,
			{
				templateDir,
				initialWorkspaceDir: this.options.initialWorkspaceDir,
				rustcVersion: await rustcVersionAsync(
					this.toolchainInfo.cargoBin,
					existsSync(this.workspace) ? this.workspace : templateDir,
					context,
				),
				wasmedgeVersion: this.toolchainInfo.wasmedgeVersion,
				configurationHash: preludeConfigurationHash(extras),
				configure: async (workspace) => {
					const skills = withInheritedSkills(workspace, this.options.rustSkills ?? []);
					for (const extra of extras) {
						if (skills.some((skill) => skill.crateName === extra.name.replaceAll("-", "_"))) {
							throw new Error(`preludeExtra crate conflicts with a mounted skill: ${extra.name}`);
						}
					}
					onProgress?.("Preparing configured prelude dependencies...");
					await configurePreludeExtra(
						workspace,
						extras,
						this.toolchainInfo!.cargoBin,
						context,
						this.cargoSandbox,
						this.options.processLimits,
						this.options.processGroup,
					);
					await syncRustSkillsAsync(workspace, skills, context, {
						cargoBin: this.toolchainInfo!.cargoBin,
						cargoSandbox: this.cargoSandbox,
						processLimits: this.options.processLimits,
						processGroup: this.options.processGroup,
					});
				},
				validate: async (workspace) => {
					const command = cargoCommand(
						this.toolchainInfo!.cargoBin,
						["build", "--release", "--offline", "-p", "cell"],
						{
							cwd: workspace,
							cargoSandbox: this.cargoSandbox,
							processLimits: this.options.processLimits,
							processGroup: this.options.processGroup,
						},
					);
					await withBuildPermit(() => context.exec(command, workspace), context.signal);
				},
				onProgress,
			},
			context,
		);
		context.check();
		const rustSkills = withInheritedSkills(this.workspace, this.options.rustSkills ?? []);
		for (const extra of extras) {
			if (rustSkills.some((skill) => skill.crateName === extra.name.replaceAll("-", "_"))) {
				throw new Error(`preludeExtra crate conflicts with a mounted skill: ${extra.name}`);
			}
		}
		if (rustSkills.length > 0 || existsSync(join(this.workspace, ".skills-hash"))) {
			onProgress?.("Mounting rust skills...");
			const sync = await syncRustSkillsAsync(this.workspace, rustSkills, context, {
				cargoBin: this.toolchainInfo.cargoBin,
				cargoSandbox: this.cargoSandbox,
				processLimits: this.options.processLimits,
				processGroup: this.options.processGroup,
			});
			for (const failure of sync.failed) {
				this.options.onDiagnostic?.(`rust skill "${failure.name}" was unmounted: ${failure.message}`);
			}
		}
		const history = this.options.workspaceDir ? new WorkspaceHistory(this.workspace) : undefined;
		context.check();
		await history?.ensure({ signal: context.signal });
		context.check();
		if (!this.bridgeServer) {
			this.bridgeServer = new BridgeServer({
				handlers: {
					...this.options.hostHandlers,
					"api.describe": createRustdocHandler({
						workspace: this.workspace,
						cargoSandbox: this.cargoSandbox,
						processLimits: this.options.processLimits,
						processGroup: this.options.processGroup,
						toolchain: this.options.rustdocToolchain,
						timeoutMs: this.options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS,
					}),
					"deps.add": createDependencyHandler({
						workspace: this.workspace,
						cargoSandbox: this.cargoSandbox,
						processLimits: this.options.processLimits,
						processGroup: this.options.processGroup,
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
			processGroup: this.options.processGroup,
			cargoBin: this.toolchainInfo.cargoBin,
			wasmedgeBin: this.toolchainInfo.wasmedgeBin,
			timeoutMs: this.options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS,
			cellGasLimit: this.options.cellGasLimit,
			cellMemoryPageLimit: this.options.cellMemoryPageLimit,
		});
		return new CellRunner({
			runtimeMode: this.options.runtimeMode,
			libraryTestGate: this.libraryTestGate,
			workspaceWritePolicy: this.workspaceWritePolicy,
			cwd: this.options.cwd,
			workspaceDir: this.workspace,
			cargoSandbox: this.cargoSandbox,
			processLimits: this.options.processLimits,
			processGroup: this.options.processGroup,
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
			this.workspaceLease?.release();
			this.workspaceLease = undefined;
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
