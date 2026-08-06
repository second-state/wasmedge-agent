/** rust-cell runtime: WasmEdge-sandboxed Rust cell execution replacing the
 * IPython kernel (DESIGN.md §2). The provisioner mirrors the lifecycle shape
 * the kernel provisioner had so AgentSession wiring stays small. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CellRunner } from "./cell-runner.js";
import { isTemplateWarm, resolveToolchain, type ToolchainInfo, warmTemplate } from "./toolchain.js";
import { ensureWorkspaceAt, listPersistentState, type PersistentStateListing } from "./workspace.js";

export { CellRunner, composeToolText } from "./cell-runner.js";
export { isTemplateWarm, resolveToolchain, type ToolchainInfo, warmTemplate } from "./toolchain.js";
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
	removeWorkspace,
	resolveTemplateDir,
} from "./workspace.js";

export interface RustCellProvisionerOptions {
	/** Project directory mounted at /workspace. */
	cwd: string;
	/** Persistent workspace dir (session artifacts); temp dir when omitted. */
	workspaceDir?: string;
	/** Per-cell budget in ms (compile + run). */
	cellTimeoutMs?: number;
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

	constructor(options: RustCellProvisionerOptions) {
		this.options = options;
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
		if (!isTemplateWarm()) {
			onProgress?.("Warming the cell workspace template (one-time)...");
			warmTemplate(this.toolchainInfo.cargoBin);
		}
		onProgress?.("Preparing the cell workspace...");
		this.workspace = this.options.workspaceDir ?? mkdtempSync(join(tmpdir(), "wasmedge-agent-ws-"));
		ensureWorkspaceAt(this.workspace);
		return new CellRunner({
			cwd: this.options.cwd,
			workspaceDir: this.workspace,
			wasmedgeBin: this.toolchainInfo.wasmedgeBin,
			cargoBin: this.toolchainInfo.cargoBin,
			cellTimeoutMs: this.options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS,
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
	}
}
