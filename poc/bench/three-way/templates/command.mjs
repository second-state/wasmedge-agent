import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

const executable = @REAL_JSON@, log = @LOG_JSON@;
const args = process.argv.slice(2), id = randomUUID();
const start = process.hrtime.bigint();
const common = { id, pid: process.pid, executable, args, cwd: process.cwd(), startMonoNs: start.toString() };
appendFileSync(log, `${JSON.stringify({ type: "start", ...common })}\n`, { mode: 0o600 });
const child = spawn(executable, args, { env: process.env, stdio: "inherit" });
let completed = false;
function finish(exitCode, signal) {
  if (completed) return;
  completed = true;
  appendFileSync(log, `${JSON.stringify({ type: "end", ...common, endMonoNs: process.hrtime.bigint().toString(), exitCode, signal })}\n`, { mode: 0o600 });
  process.exitCode = exitCode ?? 128;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.once("error", () => finish(127, null));
child.once("close", finish);
