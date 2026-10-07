import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { cargoEnvironment } from "./cargo-environment.js";
import type { ProcessResourceGroup } from "./process-group.js";
import { type ProcessLimits, resourceLimitedCommand, runtimeProcessLimits } from "./process-limits.js";

export type CargoSandbox = "off" | "bubblewrap";

export function normalizeCargoSandbox(value: unknown, platform = process.platform): CargoSandbox {
	if (value === undefined || value === "off") return "off";
	if (value !== "bubblewrap") throw new Error('rustCell.cargoSandbox must be "off" or "bubblewrap"');
	if (platform !== "linux") throw new Error("rustCell.cargoSandbox bubblewrap requires Linux");
	return value;
}

export function cargoTargetDir(workspace: string, sandbox?: CargoSandbox): string {
	return join(workspace, "target", ...(sandbox === "bubblewrap" ? ["cargo-sandbox"] : []));
}

/** Host consumers must not follow compiler-created artifact links out of the cache. */
export function cargoArtifactPath(workspace: string, sandbox: CargoSandbox | undefined, path: string): string {
	if (sandbox !== "bubblewrap") return path;
	const target = realpathSync(cargoTargetDir(workspace, sandbox));
	const artifact = realpathSync(path);
	if (!within(target, artifact)) throw new Error("Cargo artifact escapes the isolated build cache");
	return artifact;
}

function within(parent: string, path: string): boolean {
	const tail = relative(parent, path);
	return tail === "" || (tail !== ".." && !tail.startsWith("../") && !isAbsolute(tail));
}

/** Build a complete command, shared by synchronous provisioning and async cells.
 * Vendoring alone shares the host network; no fallback runs an unwrapped command. */
export function cargoCommand(
	bin: string,
	args: string[],
	options: {
		cwd: string;
		cargoSandbox?: CargoSandbox;
		processLimits?: ProcessLimits | null;
		processGroup?: ProcessResourceGroup | null;
		env?: NodeJS.ProcessEnv;
		network?: boolean;
	},
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
	const mode = normalizeCargoSandbox(options.cargoSandbox);
	const processLimits = runtimeProcessLimits(options.processLimits, mode);
	runtimeProcessLimits(options.processGroup?.limits, mode, "rustCell.treeProcessLimits");
	const env = options.env ?? cargoEnvironment();
	if (mode === "off") return { bin, args, env };
	if (!existsSync("/usr/bin/bwrap")) throw new Error("Cargo sandbox requires Bubblewrap at /usr/bin/bwrap");
	if (!isAbsolute(bin) || (env.RUSTC && !isAbsolute(env.RUSTC)))
		throw new Error("Cargo sandbox requires absolute tool binary paths");
	const workspace = realpathSync(options.cwd);
	const home = realpathSync(homedir());
	if (
		within(workspace, home) ||
		["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/tmp", "/var"].includes(workspace)
	)
		throw new Error("Cargo sandbox requires a dedicated workspace directory");
	const cargoHome = resolve(env.CARGO_HOME ?? join(home, ".cargo"));
	const rustupHome = resolve(env.RUSTUP_HOME ?? join(home, ".rustup"));
	const binary = resolve(bin);
	const system = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
	const wrapped = [
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--dir",
		"/tmp/home",
		"--dir",
		"/tmp/cargo-home",
	];
	for (const path of system) if (existsSync(path)) wrapped.push("--ro-bind", path, path);
	for (const path of ["/etc/ld.so.cache", "/etc/alternatives"])
		if (existsSync(path)) wrapped.push("--ro-bind", path, path);
	const readonly = (path: string) => {
		const source = realpathSync(path);
		if (source === "/" || within(source, home) || within(source, workspace)) {
			throw new Error(`Cargo sandbox refuses a broad toolchain or skill mount: ${path}`);
		}
		wrapped.push("--ro-bind", source, path);
	};
	// Rustup proxies need sibling tools and their installed toolchains, but not
	// Cargo's user configuration, credentials, or unrelated home directories.
	if (!system.some((path) => within(path, binary))) readonly(dirname(binary));
	if (existsSync(rustupHome)) readonly(rustupHome);
	const rustc = env.RUSTC;
	if (rustc && !system.some((path) => within(path, resolve(rustc)))) readonly(dirname(resolve(rustc)));
	const registry = join(cargoHome, "registry");
	if (existsSync(registry)) {
		const source = realpathSync(registry);
		if (source === "/" || within(source, home) || within(source, workspace))
			throw new Error("Cargo sandbox requires a dedicated Cargo registry directory");
		wrapped.push(options.network ? "--bind" : "--ro-bind", source, "/tmp/cargo-home/registry");
	}
	if (options.network) {
		wrapped.push("--share-net");
		for (const path of ["/etc/resolv.conf", "/etc/hosts", "/etc/ssl/certs"]) {
			if (existsSync(path)) wrapped.push("--ro-bind", path, path);
		}
	}
	// Only linked skill directories are additional source inputs. Other symlinks
	// can resolve only to paths already visible inside the sandbox.
	const skills = join(workspace, "skills");
	if (existsSync(skills)) {
		for (const name of readdirSync(skills)) {
			const path = join(skills, name);
			if (lstatSync(path).isSymbolicLink()) readonly(realpathSync(path));
		}
	}
	const target = cargoTargetDir(workspace, mode);
	for (const path of [join(workspace, "target"), target]) {
		if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new Error("Cargo sandbox target directories must not be symlinks");
		mkdirSync(path, { recursive: true });
	}
	const lock = join(workspace, "Cargo.lock");
	const lockStat = lstatSync(lock, { throwIfNoEntry: false });
	if (lockStat && (!lockStat.isFile() || lockStat.nlink !== 1))
		throw new Error("Cargo sandbox Cargo.lock must be a regular file without hard links");
	if (!lockStat) writeFileSync(lock, "", { flag: "wx" });
	wrapped.push(
		"--ro-bind",
		workspace,
		workspace,
		"--tmpfs",
		join(workspace, "target"),
		"--bind",
		target,
		target,
		"--bind",
		lock,
		lock,
	);
	if (options.network) {
		const vendor = resolve(workspace, args.at(-1) ?? "");
		if (
			![join(workspace, "vendor"), join(workspace, "vendor.tmp")].includes(vendor) ||
			lstatSync(vendor, { throwIfNoEntry: false })?.isSymbolicLink()
		)
			throw new Error("Cargo sandbox vendoring requires a workspace vendor directory");
		mkdirSync(vendor, { recursive: true });
		wrapped.push("--bind", vendor, vendor);
	}
	for (const name of [".git", "state", ".scratch"]) {
		const path = join(workspace, name);
		const entry = lstatSync(path, { throwIfNoEntry: false });
		if (!entry) continue;
		if (!entry.isDirectory()) throw new Error(`Cargo sandbox ${name} must be a directory without symlinks`);
		wrapped.push("--tmpfs", path);
	}
	// A configured Cargo home can sit inside /usr or an exposed tool directory.
	// Hide its config and credentials at that original path as well.
	for (const name of ["config", "config.toml", "credentials", "credentials.toml"]) {
		const path = join(cargoHome, name);
		if (existsSync(path)) wrapped.push("--ro-bind", "/dev/null", path);
	}
	const buildTarget = options.env?.CARGO_TARGET_DIR ?? target;
	if (!within(target, resolve(buildTarget))) throw new Error("Cargo sandbox build target must stay in its cache");
	wrapped.push("--chdir", workspace, "--", binary, ...args);
	return resourceLimitedCommand(
		{
			bin: "/usr/bin/bwrap",
			args: wrapped,
			env: {
				...env,
				HOME: "/tmp/home",
				CARGO_HOME: "/tmp/cargo-home",
				RUSTUP_HOME: rustupHome,
				RUSTUP_AUTO_INSTALL: "0",
				PATH: [dirname(binary), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
				TMPDIR: "/tmp",
				TMP: "/tmp",
				TEMP: "/tmp",
				CARGO_NET_OFFLINE: options.network ? env.CARGO_NET_OFFLINE : "true",
				CARGO_TARGET_DIR: buildTarget,
				CARGO_BUILD_TARGET_DIR: buildTarget,
				CARGO_BUILD_BUILD_DIR: buildTarget,
			},
		},
		processLimits,
		options.processGroup,
	);
}
