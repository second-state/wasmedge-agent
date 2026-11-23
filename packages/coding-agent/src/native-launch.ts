#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_NAME_WARNINGS, nativeHostEnv, resolveLegacyNameWarningsEarly, warnIfLegacyAlias } from "./config.js";

import { migrateAgentDirIfNeeded } from "./migrations.js";

migrateAgentDirIfNeeded();
resolveLegacyNameWarningsEarly(process.cwd());
warnIfLegacyAlias(process.argv[1] ?? "", (message) => process.stderr.write(message));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = process.platform === "win32" ? "wasmedge-agent.exe" : "wasmedge-agent";
const binary = join(root, "dist", "native", `${process.platform}-${process.arch}`, exe);
const env = { ...nativeHostEnv(), PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR || root };
for (const warning of LEGACY_NAME_WARNINGS) console.error(warning);
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", env });
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => child.kill(signal));
}
process.on("SIGINT", () => {
	/* The foreground terminal sends SIGINT to both processes. */
});
child.once("error", (error) => {
	console.error(`Cannot launch ${binary}: ${error.message}`);
	process.exitCode = 1;
});
child.once("exit", (code, signal) => {
	if (signal) {
		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
	} else {
		process.exitCode = code ?? 1;
	}
});
