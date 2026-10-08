import { createInterface } from "node:readline";
import { rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RustCellProvisioner } from "@SOURCE@/packages/coding-agent/dist/core/rust-cell/index.js";
import { createRustTool } from "@SOURCE@/packages/coding-agent/dist/core/tools/rust.js";

const settings = { runtimeMode: process.env.BENCH_RUNTIME_MODE ?? "interpreter", cwd: process.env.BENCH_PROJECT, workspaceDir: process.env.BENCH_WORKSPACE, cellTimeoutMs: 120000, libraryTestGate: process.env.BENCH_LIBRARY_TEST_GATE === "1", hostHandlers: { "bench.command": async (payload) => { const start=performance.now(); const value=await promisify(execFile)("/bin/sh",["-c",payload.command],{cwd:process.env.BENCH_PROJECT}); console.log(JSON.stringify({event:"native_command",durationMs:performance.now()-start})); return {stdout:value.stdout,stderr:value.stderr,exitCode:0}; }, "bench.echo": async (payload) => {
  const start = performance.now();
  if (payload.delayMs) await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
  console.log(JSON.stringify({ event: "host_handler", durationMs: performance.now() - start, bytes: Buffer.byteLength(JSON.stringify(payload)) }));
  return payload;
} } };
let provisioner = new RustCellProvisioner(settings), tool = createRustTool(settings.cwd, { provisioner });
const emit = (value) => console.log(JSON.stringify(value));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line), start = performance.now();
  try {
    let result;
    if (request.op === "start") { await provisioner.ensure(); result = { status: "ok" }; }
    else if (request.op === "clear-target") { rmSync(`${settings.workspaceDir}/target`, { recursive: true, force: true }); result = { status: "ok" }; }
    else if (request.op === "restart") { await provisioner.dispose(); provisioner = new RustCellProvisioner(settings); tool = createRustTool(settings.cwd, { provisioner }); await provisioner.ensure(); result = { status: "ok" }; }
    else if (request.op === "snapshot" || request.op === "restore") result = { status: "not_applicable" };
    else if (request.op === "dispose") { await provisioner.dispose(); emit({ id: request.id, status: "ok", durationMs: performance.now() - start }); break; }
    else {
      const controller = new AbortController();
      const timer = request.abortAfterMs ? setTimeout(() => controller.abort(), request.abortAfterMs) : null;
      try { result = (await tool.execute(request.id, { code: request.code, ...(request.lib ? { lib: request.lib } : {}) }, controller.signal)).details; }
      finally { if (timer) clearTimeout(timer); }
    }
    emit({ id: request.id, status: result?.status ?? "ok", durationMs: performance.now() - start, result });
  } catch (error) { emit({ id: request.id, status: "error", durationMs: performance.now() - start, error: String(error) }); }
}
await provisioner.dispose();
