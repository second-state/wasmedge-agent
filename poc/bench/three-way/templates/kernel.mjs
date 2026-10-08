import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ReplKernelManager } from "@SOURCE@/packages/coding-agent/dist/core/kernel/repl-manager.js";
import { buildRlmBootstrapCode } from "@SOURCE@/packages/coding-agent/dist/core/tools/ipython.js";

const bootstrapCode = buildRlmBootstrapCode();
const manager = new ReplKernelManager({
  cwd: process.env.BENCH_PROJECT, python: process.env.BENCH_PYTHON,
  sessionId: "direct-benchmark", bootstrapCode,
  snapshot: { path: `${process.env.BENCH_WORKSPACE}/state.dill`, manifestPath: `${process.env.BENCH_WORKSPACE}/state.json`, debounceMs: 60000 },
  hostHandlers: { "bench.command": async (payload) => { const start=performance.now(); const value=await promisify(execFile)("/bin/sh",["-c",payload.command],{cwd:process.env.BENCH_PROJECT}); console.log(JSON.stringify({event:"native_command",durationMs:performance.now()-start})); return {stdout:value.stdout,stderr:value.stderr,exitCode:0}; }, "bench.echo": async (payload) => {
    const start = performance.now();
    if (payload.delayMs) await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
    console.log(JSON.stringify({ event: "host_handler", durationMs: performance.now() - start, bytes: Buffer.byteLength(JSON.stringify(payload)) }));
    return payload;
  } },
});
const emit = (value) => console.log(JSON.stringify(value));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line), start = performance.now();
  try {
    let result;
    if (request.op === "start") { await manager.start(); result = await manager.execute(bootstrapCode, { internal: true }); }
    else if (request.op === "snapshot") result = await manager.snapshotState();
    else if (request.op === "restart") { await manager.restart(); result = { status: "ok" }; }
    else if (request.op === "restore") result = await manager.restoreState();
    else if (request.op === "dispose") { await manager.shutdown({ snapshot: false, drainHostRequests: false }); emit({ id: request.id, status: "ok", durationMs: performance.now() - start }); break; }
    else {
      const controller = new AbortController();
      const timer = request.abortAfterMs ? setTimeout(() => controller.abort(), request.abortAfterMs) : null;
      try { result = await manager.execute(request.code, { signal: controller.signal, maxOutputChars: 2000000 }); }
      finally { if (timer) clearTimeout(timer); }
    }
    emit({ id: request.id, status: result?.status ?? "ok", durationMs: performance.now() - start, result });
  } catch (error) { emit({ id: request.id, status: "error", durationMs: performance.now() - start, error: String(error) }); }
}
await manager.shutdown({ snapshot: false, drainHostRequests: false });
