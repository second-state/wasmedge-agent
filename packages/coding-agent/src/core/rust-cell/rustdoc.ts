import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomicSync } from "../../utils/atomic-file.js";
import type { HostRequestHandler } from "../host-bridge/types.js";
import { withBuildPermit } from "./build-gate.js";
import { cargoEnvironment } from "./cargo-environment.js";
import { type CargoSandbox, cargoArtifactPath, cargoCommand, cargoTargetDir } from "./cargo-sandbox.js";
import { runProcess } from "./process.js";
import type { ProcessResourceGroup } from "./process-group.js";
import type { ProcessLimits } from "./process-limits.js";
import {
	MAX_RUSTDOC_BYTES,
	normalizeRustdocToolchain,
	RUSTDOC_CACHE_PATH,
	type RustdocCache,
	readRustdocCache,
	readRustdocJson,
	rustdocFingerprint,
} from "./rustdoc-cache.js";
import { indexRustdoc, RUSTDOC_FORMAT_VERSION } from "./rustdoc-index.js";
import { findRustupBin } from "./toolchain.js";
import { truncate } from "./types.js";
import { mountedSkillCrates } from "./workspace.js";
import { snapshotWorkspace } from "./workspace-snapshot.js";

export function createRustdocHandler(options: {
	workspace: string;
	cargoSandbox?: CargoSandbox;
	processLimits?: ProcessLimits | null;
	processGroup?: ProcessResourceGroup | null;
	toolchain?: string | null;
	timeoutMs: number;
}): HostRequestHandler {
	const toolchain = normalizeRustdocToolchain(options.toolchain);
	let pending: Promise<unknown> = Promise.resolve();
	return (payload, context) => {
		const query = async (): Promise<Record<string, unknown>> => {
			if (!context) throw new Error("api.describe requires an active cell");
			context.signal.throwIfAborted();
			if (!toolchain)
				throw new Error(
					"API introspection is disabled; set rustCell.rustdocToolchain to an installed nightly toolchain and reload",
				);
			if (Object.keys(payload).some((key) => !["path", "mode", "offset", "cellSourceCode"].includes(key))) {
				throw new Error("api.describe accepts only path, mode, and offset");
			}
			const { path, mode = "describe", offset = 0 } = payload;
			if (
				typeof path !== "string" ||
				path.length > 1024 ||
				/[\x00-\x1f]/.test(path) ||
				!/^(agent_lib|rlm)(::|$)/.test(path)
			) {
				throw new Error("API path must start with agent_lib or rlm");
			}
			if (mode !== "list" && mode !== "describe") throw new Error("API mode must be list or describe");
			if (
				typeof offset !== "number" ||
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				(mode === "describe" && offset !== 0)
			) {
				throw new Error("API offset must be a nonnegative integer and is only supported for list");
			}
			const deadline = Date.now() + options.timeoutMs;
			const timeout = AbortSignal.timeout(options.timeoutMs);
			const signal = AbortSignal.any([context.signal, timeout]);
			const env: NodeJS.ProcessEnv = {
				...cargoEnvironment(),
				RUSTUP_TOOLCHAIN: toolchain,
				RUSTUP_AUTO_INSTALL: "0",
			};
			// Use one explicitly selected compiler/rustdoc pair, not a host RUSTC override.
			delete env.RUSTC;
			const run = async (args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) => {
				const command = cargoCommand(findRustupBin(), ["run", toolchain, ...args], {
					cwd,
					cargoSandbox: options.cargoSandbox,
					processLimits: options.processLimits,
					processGroup: options.processGroup,
					env: { ...env, ...extraEnv },
				});
				const result = await runProcess(command.bin, command.args, {
					cwd,
					env: command.env,
					timeoutMs: deadline - Date.now(),
					signal,
				});
				signal.throwIfAborted();
				if (result.timedOut || result.aborted || result.exitCode !== 0) {
					throw new Error(
						`Rustdoc introspection ${result.timedOut ? "timed out" : "failed"}: ${truncate(result.stderr)}`,
					);
				}
				return result.stdout.trim();
			};
			const mounted = mountedSkillCrates(options.workspace);
			const version = await run(["rustc", "--version", "--verbose"], options.workspace);
			let cache = readRustdocCache(options.workspace, mounted);
			if (
				!cache ||
				cache.toolchain !== toolchain ||
				cache.rustcVersion !== version ||
				(cache.cargoSandbox ?? "off") !== (options.cargoSandbox ?? "off")
			) {
				const root = mkdtempSync(join(tmpdir(), "wasmedge-agent-rustdoc-"));
				try {
					const fingerprint = rustdocFingerprint(options.workspace, mounted);
					const workspace = join(root, "workspace");
					await snapshotWorkspace(options.workspace, workspace, { mountedSkillsOnly: true, signal });
					signal.throwIfAborted();
					if (rustdocFingerprint(workspace, mounted) !== fingerprint)
						throw new Error("Sources changed while taking the API snapshot; retry introspection");
					const target = join(cargoTargetDir(workspace, options.cargoSandbox), "api-build");
					const packages = ["agent_lib", "rlm", ...mounted];
					await withBuildPermit(
						() =>
							run(
								[
									"cargo",
									"doc",
									"--release",
									"--offline",
									"--locked",
									"--target",
									"wasm32-wasip1",
									"--no-deps",
									"--lib",
									...packages.flatMap((name) => ["-p", name]),
								],
								workspace,
								{
									CARGO_TARGET_DIR: target,
									CARGO_BUILD_TARGET_DIR: target,
									CARGO_BUILD_BUILD_DIR: target,
									RUSTDOCFLAGS: "-Z unstable-options --output-format=json",
								},
							),
						signal,
					);
					const documents = Object.fromEntries(
						packages.map((name) => [
							name,
							readRustdocJson(
								cargoArtifactPath(
									workspace,
									options.cargoSandbox,
									join(target, "wasm32-wasip1", "doc", `${name}.json`),
								),
							),
						]),
					);
					const items = indexRustdoc(documents);
					signal.throwIfAborted();
					if (
						rustdocFingerprint(workspace, mounted) !== fingerprint ||
						rustdocFingerprint(options.workspace, mounted) !== fingerprint
					) {
						throw new Error("Sources changed during API introspection; retry introspection");
					}
					cache = {
						schema: 1,
						cargoSandbox: options.cargoSandbox ?? "off",
						formatVersion: RUSTDOC_FORMAT_VERSION,
						target: "wasm32-wasip1",
						toolchain,
						rustcVersion: version,
						fingerprint,
						items,
					} satisfies RustdocCache;
					const serialized = JSON.stringify(cache);
					if (Buffer.byteLength(serialized) > MAX_RUSTDOC_BYTES)
						throw new Error("Rustdoc API cache exceeds 32 MiB");
					mkdirSync(join(options.workspace, "target"), { recursive: true });
					writeFileAtomicSync(join(options.workspace, RUSTDOC_CACHE_PATH), serialized);
				} finally {
					await rm(root, { recursive: true, force: true });
				}
			}
			signal.throwIfAborted();
			const matches = cache.items.filter(
				(item) => item.path === path || (mode === "list" && item.path.startsWith(`${path}::`)),
			);
			if (matches.length === 0)
				throw new Error(`No documented public API at ${path}; use rlm::api::list to find available paths`);
			const items: unknown[] = [];
			let bytes = 0;
			for (const item of mode === "list" ? matches.slice(offset, offset + 50) : matches) {
				const entry =
					mode === "list"
						? { path: item.path, kind: item.kind }
						: {
								...item,
								docs: item.docs?.slice(0, 8000) ?? null,
								...(item.docs && item.docs.length > 8000 ? { docsTruncated: true } : {}),
							};
				const size = Buffer.byteLength(JSON.stringify(entry));
				if (bytes + size > 32_000) {
					if (mode === "describe" || items.length === 0)
						throw new Error(
							"API declaration exceeds the response limit; list its child paths and describe a smaller item",
						);
					break;
				}
				bytes += size;
				items.push(entry);
			}
			const next = offset + items.length;
			return {
				source: "rustdoc-json",
				target: cache.target,
				cfg: ["doc"],
				toolchain: cache.toolchain,
				rustcVersion: cache.rustcVersion,
				formatVersion: cache.formatVersion,
				path,
				items,
				total: matches.length,
				nextOffset: next < matches.length ? next : null,
			};
		};
		const result = pending.then(query);
		pending = result.catch(() => {});
		return result;
	};
}
