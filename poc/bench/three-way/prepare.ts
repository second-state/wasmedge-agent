import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { hashTree, sha256, writeJson } from "./files.js";
import { cleanEnvironment, timedProcess } from "./process.js";
import type { Variant } from "./types.js";

export const REVISIONS = {
	"prime-ts": "7d442aafa985f9342134fac16c2ef41f03fb45c1",
	"prime-rust": "967eb13fd488507af5f590e9c6ea8b2672f1fc05",
};

export interface Prepared {
	version: 1;
	variants: Variant[];
	runtimeCommands: Record<string, { command: string; args: string[] }>;
	env: NodeJS.ProcessEnv;
	identity: Record<string, unknown>;
}

export async function prepare(
	root: string,
	inputs = resolve(root, "poc/bench/results/three-way-inputs"),
): Promise<Prepared> {
	mkdirSync(inputs, { recursive: true, mode: 0o700 });
	const repo = resolve(root),
		ts = join(inputs, "prime-ts"),
		rust = join(inputs, "prime-rust");
	const env = cleanEnvironment({ HUSKY: "0", UV_CACHE_DIR: join(inputs, "uv-cache") });
	async function command(bin: string, args: string[], cwd: string, label: string) {
		console.log(`prepare: ${label}`);
		const result = await timedProcess(bin, args, cwd, env, join(inputs, `${label}.log`), 900_000);
		if (result.exitCode !== 0) throw new Error(`Preparation failed: ${label}; inspect ${inputs}/${label}.log`);
	}
	for (const [directory, id] of [
		[ts, "prime-ts"],
		[rust, "prime-rust"],
	] as const) {
		if (!existsSync(join(directory, id === "prime-ts" ? "package.json" : "Cargo.toml"))) {
			const archive = join(inputs, `${id}.tar.gz`);
			await command(
				"curl",
				[
					"--fail",
					"--location",
					"--retry",
					"2",
					`https://codeload.github.com/PrimeIntellect-ai/prime-agent/tar.gz/${REVISIONS[id]}`,
					"--output",
					archive,
				],
				repo,
				`download-${id}`,
			);
			mkdirSync(directory, { recursive: true });
			await command("tar", ["-xzf", archive, "--strip-components=1", "-C", directory], repo, `extract-${id}`);
		}
	}
	if (!existsSync(join(ts, "node_modules/.package-lock.json")))
		await command("npm", ["ci", "--cache", join(inputs, "npm-cache")], ts, "install-prime-ts");
	if (!existsSync(join(ts, "packages/coding-agent/dist/bundle/cli.js")))
		await command("npm", ["run", "build"], ts, "build-prime-ts");
	if (!existsSync(join(repo, "packages/coding-agent/dist/bundle/cli.js")))
		await command("npm", ["run", "build"], repo, "build-wasmedge");
	const rustTarget = join(inputs, "build-prime-rust"),
		rustBin = join(rustTarget, "release/prime-agent");
	if (!existsSync(rustBin))
		await command(
			"cargo",
			["build", "--release", "--locked", "-p", "pa-cli", "--target-dir", rustTarget],
			rust,
			"build-prime-rust",
		);
	const rustAdapter = join(rust, "crates/pa-core/examples/three_way_kernel.rs");
	cpSync(join(repo, "poc/bench/three-way/templates/three_way_kernel.rs"), rustAdapter);
	await command(
		"cargo",
		[
			"build",
			"--release",
			"--locked",
			"-p",
			"pa-core",
			"--example",
			"three_way_kernel",
			"--example",
			"kernel_bench",
			"--target-dir",
			rustTarget,
		],
		rust,
		"build-runtime-adapter",
	);
	for (const [id, source, template] of [
		["prime-ts", ts, "kernel"],
		["wasmedge", repo, "wasm"],
	]) {
		writeFileSync(
			join(inputs, `${id}-runtime.mjs`),
			readFileSync(join(repo, `poc/bench/three-way/templates/${template}.mjs`), "utf8").replaceAll(
				"@SOURCE@",
				source,
			),
			{ mode: 0o600 },
		);
	}
	const wasm = process.env.WASMEDGE_AGENT_WASMEDGE ?? join(inputs, "WasmEdge-0.14.1-Darwin/bin/wasmedge");
	if (!existsSync(wasm))
		throw new Error("Install WasmEdge 0.14.1 or set WASMEDGE_AGENT_WASMEDGE; see three-way README");
	const template = join(
		inputs,
		`wasm-template-${hashTree(join(repo, "wasmedge-agent-runtime/template")).slice(0, 16)}`,
	);
	if (!existsSync(template))
		cpSync(join(repo, "wasmedge-agent-runtime/template"), template, {
			recursive: true,
			filter: (path) => !["target", "vendor"].includes(path.split("/").at(-1) ?? ""),
		});
	env.WASMEDGE_AGENT_WASMEDGE = wasm;
	env.WASMEDGE_AGENT_TEMPLATE_DIR = template;
	const warmup = join(inputs, "warmup.mjs");
	writeFileSync(
		warmup,
		`import { ensureTemplateReady } from ${JSON.stringify(`${repo}/packages/coding-agent/dist/core/rust-cell/toolchain.js`)}; ensureTemplateReady("cargo");\n`,
	);
	await command(process.execPath, [warmup], repo, "warm-wasm-template");
	for (const [id, source] of [
		["prime-ts", ts],
		["prime-rust", rust],
	]) {
		env.PRIME_AGENT_KERNEL_VENV = join(inputs, `${id}-venv`);
		// Each pinned upstream runtime owns its own environment and bootstrap marker.
		const bootstrap = join(inputs, `${id}-bootstrap.mjs`);
		const bootstrapSource = id === "prime-ts" ? source : ts;
		writeFileSync(
			bootstrap,
			`import { ensureKernelPython } from ${JSON.stringify(`${bootstrapSource}/packages/coding-agent/dist/core/kernel/bootstrap.js`)}; console.log(await ensureKernelPython());\n`,
		);
		if (id === "prime-rust") {
			// Use the native implementation's packaged runtime and default extras.
			await command(
				join(rustTarget, "release/examples/kernel_bench"),
				["ensure-python"],
				rust,
				"bootstrap-prime-rust",
			);
		} else await command(process.execPath, [bootstrap], source, "bootstrap-prime-ts");
	}
	delete env.PRIME_AGENT_KERNEL_VENV;
	const variants: Variant[] = [
		{
			id: "prime-ts",
			baseRevision: REVISIONS["prime-ts"],
			sourceRoot: ts,
			command: process.execPath,
			args: [join(ts, "packages/coding-agent/dist/bundle/cli.js")],
			inputsHash: hashTree(ts),
			launcherHash: sha256(readFileSync(join(ts, "packages/coding-agent/dist/bundle/cli.js"))),
		},
		{
			id: "prime-rust",
			baseRevision: REVISIONS["prime-rust"],
			sourceRoot: rust,
			command: rustBin,
			args: [],
			inputsHash: hashTree(rust),
			launcherHash: sha256(readFileSync(rustBin)),
		},
		{
			id: "wasmedge",
			baseRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
			sourceRoot: repo,
			command: process.execPath,
			args: [join(repo, "packages/coding-agent/dist/bundle/cli.js")],
			inputsHash: hashTree(join(repo, "packages/coding-agent")),
			launcherHash: sha256(readFileSync(join(repo, "packages/coding-agent/dist/bundle/cli.js"))),
		},
	];
	variants.find((variant) => variant.id === "wasmedge")!.runtimeMode = "interpreter";
	variants.push({ ...variants.find((variant) => variant.id === "wasmedge")!, id: "wasmedge-aot", runtimeMode: "aot" });
	const prepared: Prepared = {
		version: 1,
		variants,
		runtimeCommands: {
			"prime-ts": { command: process.execPath, args: [join(inputs, "prime-ts-runtime.mjs")] },
			"prime-rust": { command: join(rustTarget, "release/examples/three_way_kernel"), args: [] },
			wasmedge: { command: process.execPath, args: [join(inputs, "wasmedge-runtime.mjs")] },
			"wasmedge-aot": { command: process.execPath, args: [join(inputs, "wasmedge-runtime.mjs")] },
		},
		env,
		identity: {
			platform: process.platform,
			arch: process.arch,
			osRelease: release(),
			cpu: cpus()[0]?.model,
			logicalCpus: cpus().length,
			memoryBytes: totalmem(),
			node: process.version,
			python: Object.fromEntries(
				["prime-ts", "prime-rust"].map((id) => [
					id,
					execFileSync(join(inputs, `${id}-venv/bin/python`), ["--version"], { encoding: "utf8" }).trim(),
				]),
			),
			wasmedge: execFileSync(wasm, ["--version"], { encoding: "utf8" }).trim(),
			cargo: execFileSync("cargo", ["--version"], { encoding: "utf8" }).trim(),
			rustc: execFileSync("rustc", ["-vV"], { encoding: "utf8" }).trim(),
			templateHash: hashTree(template),
			adapterHash: hashTree(join(repo, "poc/bench/three-way/templates")),
			archives: Object.fromEntries(
				["prime-ts", "prime-rust"].map((id) => [id, sha256(readFileSync(join(inputs, `${id}.tar.gz`)))]),
			),
		},
	};
	writeJson(join(inputs, "prepared.json"), prepared);
	return prepared;
}
