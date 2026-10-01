import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { BridgeServer } from "../src/core/rust-cell/bridge-server.js";
import { runProcess } from "../src/core/rust-cell/process.js";
import { StdioBridge, stdioBridgePrefix } from "../src/core/rust-cell/stdio-bridge.js";

function decoder(maxFrameBytes?: number) {
	const output: Buffer[] = [];
	const frames: Buffer[] = [];
	const replies: Buffer[] = [];
	const errors: Error[] = [];
	const input = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			replies.push(chunk);
			callback();
		},
	});
	const bridge = new StdioBridge(
		input,
		"token",
		(chunk) => output.push(chunk),
		(error) => errors.push(error),
		maxFrameBytes,
	);
	bridge.connection.on("data", (frame: Buffer) => frames.push(frame));
	return { bridge, output, frames, replies, errors };
}

describe("stdio bridge framing", () => {
	it("preserves ordinary UTF-8 and partial markers while extracting fragmented frames", async () => {
		const d = decoder();
		const prefix = stdioBridgePrefix("token");
		const frame = '{"text":"你好"}\n';
		const data = Buffer.concat([
			Buffer.from("before🙂"),
			prefix,
			Buffer.from(frame),
			Buffer.from("after\n"),
			prefix,
			Buffer.from("{}\n\x1eRL"),
		]);
		for (const byte of data) d.bridge.write(Buffer.from([byte]));
		await setImmediate();
		d.bridge.connection.write("reply\n");
		d.bridge.finish();
		await setImmediate();
		expect(Buffer.concat(d.output).toString()).toBe("before🙂after\n\x1eRL");
		expect(d.frames.map((frame) => frame.toString())).toEqual([frame, "{}\n"]);
		expect(Buffer.concat(d.replies).toString()).toBe("reply\n");
		expect(d.errors).toEqual([]);
	});

	it.each([false, true])("bounds complete and incomplete frames (newline=%s)", async (newline) => {
		const d = decoder(32);
		d.bridge.write(Buffer.concat([stdioBridgePrefix("token"), Buffer.from("x".repeat(33) + (newline ? "\n" : ""))]));
		await setImmediate();
		expect(d.errors.some((error) => error.message.includes("line-length limit"))).toBe(true);
		expect(d.frames).toEqual([]);
		d.bridge.finish();
	});

	it("rejects an unfinished frame on EOF", () => {
		const d = decoder();
		d.bridge.write(Buffer.concat([stdioBridgePrefix("token"), Buffer.from("{")]));
		d.bridge.finish();
		expect(d.errors[0].message).toContain("incomplete frame");
	});

	it("renews stdio handshakes, cancels old handlers, and discards late replies", async () => {
		const d = decoder();
		let release!: () => void;
		let signal: AbortSignal | undefined;
		const server = new BridgeServer({
			handlers: {
				slow: async (_payload, context) => {
					signal = context!.signal;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return { old: true };
				},
				echo: async () => ({ fresh: true }),
			},
		});
		server.beginCell({ cellId: "cell", code: "source" });
		server.attachStdio(d.bridge.connection);
		const send = (frame: Record<string, unknown>) =>
			d.bridge.connection.push(Buffer.from(`${JSON.stringify({ v: 1, ...frame })}\n`));
		try {
			send({ kind: "hello", token: server.token, cell: "cell" });
			send({ kind: "req", id: 1, type: "slow" });
			await vi.waitFor(() => expect(release).toBeDefined());
			send({ kind: "hello", token: server.token, cell: "cell" });
			send({ kind: "req", id: 1, type: "echo" });
			expect(signal?.aborted).toBe(true);
			release();
			await setImmediate();
			const frames = Buffer.concat(d.replies)
				.toString()
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(frames).toEqual([
				{ v: 1, kind: "hello_ok" },
				{ v: 1, kind: "hello_ok" },
				{ v: 1, kind: "res", id: 1, status: "ok", payload: { fresh: true } },
			]);
			expect(server.isStarted).toBe(false);
		} finally {
			release?.();
			d.bridge.finish();
			await server.dispose();
		}
	});
});

describe("process stdio bridge", () => {
	it("keeps replies private and streams only ordinary stdout/stderr", async () => {
		const server = new BridgeServer({ handlers: { echo: async (payload) => ({ text: payload.text }) } });
		server.beginCell({ cellId: "cell", code: "source" });
		const prefix = JSON.stringify(stdioBridgePrefix(server.token).toString());
		const script = `const readline = require("node:readline");
const send = frame => process.stdout.write(${prefix} + JSON.stringify({v:1,...frame}) + "\\n");
process.stdout.write("before🙂");
process.stderr.write("diagnostic\\n");
readline.createInterface({input:process.stdin}).on("line", line => {
  const frame=JSON.parse(line);
  if(frame.kind==="hello_ok") send({kind:"req",id:1,type:"echo",payload:{text:"你好"}});
  else process.stdout.write("reply="+frame.payload.text+"\\n",()=>process.exit(0));
});
send({kind:"hello",token:${JSON.stringify(server.token)},cell:"cell"});`;
		const chunks: string[] = [];
		try {
			const result = await runProcess(process.execPath, ["-e", script], {
				cwd: process.cwd(),
				timeoutMs: 5000,
				bridge: { token: server.token, attach: (connection) => server.attachStdio(connection) },
				onChunk: (chunk, stream) => {
					if (stream === "stdout") chunks.push(chunk);
				},
			});
			expect(result).toMatchObject({
				exitCode: 0,
				stdout: "before🙂reply=你好\n",
				stderr: "diagnostic\n",
				timedOut: false,
			});
			expect(chunks.join("")).toBe(result.stdout);
			expect(server.isStarted).toBe(false);
		} finally {
			await server.dispose();
		}
	});

	it.each(["malformed", "incomplete"])("fails closed on a %s frame", async (kind) => {
		const server = new BridgeServer({ handlers: {} });
		server.beginCell({ cellId: "cell", code: "source" });
		const data = `${stdioBridgePrefix(server.token).toString()}{${kind === "malformed" ? "\n" : ""}`;
		try {
			const result = await runProcess(
				process.execPath,
				[
					"-e",
					`process.stdout.write(${JSON.stringify(data)}); ${kind === "malformed" ? "setInterval(()=>{},1000);" : ""}`,
				],
				{
					cwd: process.cwd(),
					timeoutMs: 5000,
					bridge: { token: server.token, attach: (connection) => server.attachStdio(connection) },
				},
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.timedOut).toBe(false);
			expect(result.stderr).toContain("stdio bridge");
		} finally {
			await server.dispose();
		}
	});

	it("cleans up when the runtime cannot be spawned", async () => {
		await expect(
			runProcess("/nonexistent/wasmedge", [], {
				cwd: process.cwd(),
				timeoutMs: 1000,
				bridge: { token: "token", attach: () => {} },
			}),
		).rejects.toThrow(/ENOENT/);
	});
});
