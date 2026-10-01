import { describe, expect, it } from "vitest";
import { validateWasiImports } from "../src/core/rust-cell/wasm-imports.js";

const HEADER = [0, 97, 115, 109, 1, 0, 0, 0];

function imported(module: string, name: string, kind: "function" | "memory" = "function"): Uint8Array<ArrayBuffer> {
	const string = (value: string) => [Buffer.byteLength(value), ...Buffer.from(value)];
	const descriptor = kind === "function" ? [0, 0] : [2, 0, 1];
	const imports = [1, ...string(module), ...string(name), ...descriptor];
	return new Uint8Array([...HEADER, 1, 4, 1, 96, 0, 0, 2, imports.length, ...imports]);
}

describe("WASI import policy", () => {
	it("allows ordinary WASI filesystem imports without instantiating the module", async () => {
		await expect(
			validateWasiImports(imported("wasi_snapshot_preview1", "path_open"), "cell"),
		).resolves.toBeUndefined();
		await expect(
			validateWasiImports(imported("wasi_snapshot_preview1", "fd_write"), "cell"),
		).resolves.toBeUndefined();
		// (module (func unreachable) (start 0)): compilation must not invoke start.
		const trapsOnStart = new Uint8Array([...HEADER, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 8, 1, 0, 10, 5, 1, 3, 0, 0, 11]);
		await expect(validateWasiImports(trapsOnStart, "cell")).resolves.toBeUndefined();
	});

	it.each([
		"sock_open",
		"sock_connect_v2",
		"sock_getaddrinfo",
		"sock_send_to",
		"sock_accept",
		"sock_recv",
		"sock_shutdown",
		"future_network_api",
	])("rejects %s even when the import is unused", async (name) => {
		await expect(validateWasiImports(imported("wasi_snapshot_preview1", name), "cell")).rejects.toThrow(
			`cell import not allowed: "wasi_snapshot_preview1"."${name}"`,
		);
	});

	it.each(["wasi_unstable", "env", "wasmedge_process", "wasi_ephemeral_nn", "rlm_host"])(
		"rejects imports from %s regardless of the function name",
		async (module) => {
			await expect(validateWasiImports(imported(module, "fd_write"), "cell")).rejects.toThrow("import not allowed");
		},
	);

	it("rejects non-function imports and malformed modules", async () => {
		await expect(
			validateWasiImports(imported("wasi_snapshot_preview1", "fd_write", "memory"), "cell"),
		).rejects.toThrow("(memory)");
		await expect(validateWasiImports(new Uint8Array([0, 97, 115]), "cell")).rejects.toThrow(
			"cannot inspect cell module",
		);
	});

	it("honors cancellation before and during asynchronous inspection", async () => {
		const abort = new AbortController();
		const pending = validateWasiImports(new Uint8Array(HEADER), "cell", abort.signal);
		abort.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		await expect(validateWasiImports(new Uint8Array(HEADER), "cell", abort.signal)).rejects.toThrow("cancelled");
	});
});
