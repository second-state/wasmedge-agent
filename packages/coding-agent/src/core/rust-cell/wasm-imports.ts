// The Node-only tsconfig excludes lib.dom, which owns TypeScript's WebAssembly
// declarations. Describe only the built-in APIs needed for import inspection.
const { WebAssembly } = globalThis as typeof globalThis & {
	WebAssembly: {
		compile(bytes: Uint8Array<ArrayBuffer>): Promise<unknown>;
		Module: { imports(module: unknown): { module: string; name: string; kind: string }[] };
	};
};

// WASI Preview 1 functions that need no network capability. Use an explicit
// allowlist so socket extensions and plugin imports also fail closed.
const ALLOWED_WASI_FUNCTIONS = new Set([
	"args_get",
	"args_sizes_get",
	"environ_get",
	"environ_sizes_get",
	"clock_res_get",
	"clock_time_get",
	"fd_advise",
	"fd_allocate",
	"fd_close",
	"fd_datasync",
	"fd_fdstat_get",
	"fd_fdstat_set_flags",
	"fd_fdstat_set_rights",
	"fd_filestat_get",
	"fd_filestat_set_size",
	"fd_filestat_set_times",
	"fd_pread",
	"fd_prestat_get",
	"fd_prestat_dir_name",
	"fd_pwrite",
	"fd_read",
	"fd_readdir",
	"fd_renumber",
	"fd_seek",
	"fd_sync",
	"fd_tell",
	"fd_write",
	"path_create_directory",
	"path_filestat_get",
	"path_filestat_set_times",
	"path_link",
	"path_open",
	"path_readlink",
	"path_remove_directory",
	"path_rename",
	"path_symlink",
	"path_unlink_file",
	"poll_oneoff",
	"proc_exit",
	"proc_raise",
	"random_get",
	"sched_yield",
]);

/** Compile only for validation/import inspection; never instantiate or call
 * guest code in the host's JavaScript engine. Unsupported modules are rejected
 * rather than executed without inspection. WasmEdge remains the guest runtime. */
export async function validateWasiImports(
	bytes: Uint8Array<ArrayBuffer>,
	purpose: "cell" | "skill test" | "library test",
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	let module: unknown;
	try {
		module = await WebAssembly.compile(bytes);
	} catch (error) {
		signal?.throwIfAborted();
		throw new Error(`cannot inspect ${purpose} module: ${error instanceof Error ? error.message : String(error)}`);
	}
	signal?.throwIfAborted();
	for (const imported of WebAssembly.Module.imports(module)) {
		if (
			imported.module !== "wasi_snapshot_preview1" ||
			imported.kind !== "function" ||
			!ALLOWED_WASI_FUNCTIONS.has(imported.name)
		) {
			throw new Error(
				`${purpose} import not allowed: ${JSON.stringify(imported.module)}.${JSON.stringify(imported.name)} (${imported.kind}); only non-network WASI Preview 1 functions are supported`,
			);
		}
	}
}
