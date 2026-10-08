import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { createConnection } from "node:net";
import { record } from "./files.js";

export function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"PATH",
		"HOME",
		"USER",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"SHELL",
		"RUSTUP_HOME",
		"CARGO_HOME",
		"UV_CACHE_DIR",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
	]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	return { ...env, ...extra };
}

export interface OwnedProcess {
	child: ChildProcess;
	closed: Promise<number | null>;
	exited: boolean;
}

export function launch(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	log: string,
	onLine?: (line: string) => void,
): OwnedProcess {
	const fd = openSync(log, "a", 0o600);
	const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", fd] });
	closeSync(fd);
	const owned: OwnedProcess = { child, closed: Promise.resolve(null), exited: false };
	let pending = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (data: string) => {
		appendFileSync(log, data, { mode: 0o600 });
		pending += data;
		while (true) {
			const newline = pending.indexOf("\n");
			if (newline === -1) break;
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			onLine?.(line);
		}
	});
	owned.closed = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			owned.exited = true;
			if (pending) onLine?.(pending);
			resolve(code);
		});
	});
	// A caller may still be performing readiness checks when spawn fails.
	void owned.closed.catch(() => {});
	return owned;
}

export async function killOwned(owned: OwnedProcess): Promise<void> {
	if (owned.exited || !owned.child.pid) return;
	try {
		process.kill(-owned.child.pid, "SIGTERM");
	} catch {
		/* Already exited. */
	}
	await Promise.race([owned.closed.catch(() => null), new Promise((resolve) => setTimeout(resolve, 1000))]);
	if (!owned.exited) {
		try {
			process.kill(-owned.child.pid, "SIGKILL");
		} catch {
			/* Already exited. */
		}
		await owned.closed.catch(() => null);
	}
}

export async function timedProcess(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	log: string,
	budgetMs: number,
	onLine?: (line: string) => void,
) {
	const owned = launch(command, args, cwd, env, log, onLine);
	let timedOut = false;
	const timer = setTimeout(
		() => {
			timedOut = true;
			void killOwned(owned);
		},
		Math.max(1, budgetMs),
	);
	try {
		return { exitCode: await owned.closed, timedOut };
	} finally {
		clearTimeout(timer);
		await killOwned(owned);
	}
}

function daemonExchange(socketPath: string, shutdown: boolean): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let pending = "",
			requested = false,
			settled = false;
		const finish = (value: boolean, error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(() => finish(false), 2000);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			pending += chunk;
			if (pending.length > 131072) return finish(false, new Error("Daemon frame exceeds limit"));
			while (true) {
				const newline = pending.indexOf("\n");
				if (newline === -1) break;
				let message: unknown;
				try {
					message = JSON.parse(pending.slice(0, newline));
				} catch {
					return finish(false, new Error("Invalid daemon JSON"));
				}
				pending = pending.slice(newline + 1);
				if (!record(message)) continue;
				if (message.type === "event" && record(message.event)) message = message.event;
				if (!record(message)) continue;
				if (message.type === "daemon_hello") {
					if (
						!record(message.protocol) ||
						message.protocol.name !== "prime-agent.daemon" ||
						message.protocol.version !== 7
					)
						return finish(false, new Error("Requires daemon protocol version 7"));
					if (!shutdown) return finish(true);
					if (!requested) {
						requested = true;
						socket.write(
							`${JSON.stringify({ type: "command", id: "three-way-shutdown", protocol: message.protocol, command: { type: "shutdown", force: true } })}\n`,
						);
					}
				}
				if (message.type === "response" && message.id === "three-way-shutdown")
					return finish(message.success === true);
			}
		});
		socket.once("error", () => finish(false));
		socket.once("close", () => finish(false));
	});
}

export async function waitDaemon(owned: OwnedProcess, socket: string, deadline: number): Promise<void> {
	while (!owned.exited && Date.now() < deadline) {
		if (await daemonExchange(socket, false)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Daemon exited or exceeded readiness deadline");
}

export async function stopDaemon(owned: OwnedProcess, socket: string): Promise<void> {
	// A supervisor may relaunch itself after a crash. The socket is inside a
	// directory created exclusively for this run, so its replacement is owned too.
	if (owned.exited) {
		await daemonExchange(socket, true);
		throw new Error("Daemon exited unexpectedly; owned replacement received shutdown");
	}
	const acknowledged = await daemonExchange(socket, true);
	if (acknowledged) await Promise.race([owned.closed, new Promise((resolve) => setTimeout(resolve, 10000))]);
	const graceful = acknowledged && owned.exited && owned.child.exitCode === 0;
	await killOwned(owned);
	if (!graceful) await daemonExchange(socket, true);
	if (!graceful) throw new Error("Owned daemon required forced cleanup; inspect daemon.log");
}

export async function shutdownOwnedSocket(socket: string): Promise<boolean> {
	return daemonExchange(socket, true);
}
