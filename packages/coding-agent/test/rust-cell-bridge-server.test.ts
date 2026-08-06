import { connect, type Socket } from "node:net";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { CellAttachment, CellDiffDisplay, CellSentAgentMessage } from "../src/core/host-bridge/types.js";
import { BridgeServer } from "../src/core/rust-cell/bridge-server.js";
import { loadPhoton } from "../src/utils/photon.js";

/** Minimal JSON-lines client: buffered reads, promise-based frame consumption. */
class LineClient {
	private socket: Socket;
	private buffer = "";
	private frames: unknown[] = [];
	private waiters: Array<(frame: unknown) => void> = [];
	private closedPromise: Promise<void>;

	constructor(port: number) {
		this.socket = connect(port, "127.0.0.1");
		this.socket.on("data", (data: Buffer) => {
			this.buffer += data.toString("utf-8");
			let newline = this.buffer.indexOf("\n");
			while (newline !== -1) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				const frame = JSON.parse(line);
				const waiter = this.waiters.shift();
				if (waiter) waiter(frame);
				else this.frames.push(frame);
				newline = this.buffer.indexOf("\n");
			}
		});
		this.closedPromise = new Promise((resolve) => {
			this.socket.on("close", () => resolve());
			this.socket.on("error", () => {});
		});
	}

	ready(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket.once("connect", resolve);
			this.socket.once("error", reject);
		});
	}

	write(raw: string): void {
		this.socket.write(raw);
	}

	sendFrame(frame: Record<string, unknown>): void {
		this.write(`${JSON.stringify(frame)}\n`);
	}

	nextFrame(timeoutMs = 2000): Promise<unknown> {
		const queued = this.frames.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for a bridge frame")), timeoutMs);
			this.waiters.push((frame) => {
				clearTimeout(timer);
				resolve(frame);
			});
		});
	}

	closed(timeoutMs = 2000): Promise<void> {
		return Promise.race([
			this.closedPromise,
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error("timed out waiting for the connection to close")), timeoutMs),
			),
		]);
	}

	destroy(): void {
		this.socket.destroy();
	}
}

async function handshake(server: BridgeServer, cellId = "cell-1"): Promise<LineClient> {
	const client = new LineClient(Number(server.address.split(":")[1]));
	await client.ready();
	client.sendFrame({ v: 1, kind: "hello", token: server.token, cell: cellId });
	expect(await client.nextFrame()).toEqual({ v: 1, kind: "hello_ok" });
	return client;
}

describe("BridgeServer protocol v1", () => {
	const servers: BridgeServer[] = [];
	const clients: LineClient[] = [];

	function makeServer(...args: ConstructorParameters<typeof BridgeServer>): BridgeServer {
		const server = new BridgeServer(...args);
		servers.push(server);
		return server;
	}

	afterEach(async () => {
		for (const client of clients.splice(0)) client.destroy();
		for (const server of servers.splice(0)) await server.dispose();
	});

	it("answers a valid handshake and dispatches a req with cellSourceCode injected", async () => {
		let seenPayload: Record<string, unknown> | undefined;
		const server = makeServer({
			handlers: {
				"model.info": async (payload) => {
					seenPayload = payload;
					return { id: "test-model", provider: "test" };
				},
			},
		});
		await server.start();
		server.beginCell({ cellId: "cell-1", code: "fn main() {}" });

		const client = await handshake(server);
		clients.push(client);
		client.sendFrame({ v: 1, kind: "req", id: 7, type: "model.info", payload: { extra: 1 } });
		expect(await client.nextFrame()).toEqual({
			v: 1,
			kind: "res",
			id: 7,
			status: "ok",
			payload: { id: "test-model", provider: "test" },
		});
		expect(seenPayload).toEqual({ extra: 1, cellSourceCode: "fn main() {}" });
	});

	it("rejects a handshake with a wrong token, wrong cell id, or no active cell", async () => {
		const server = makeServer({ handlers: {} });
		await server.start();
		const port = Number(server.address.split(":")[1]);

		// No active cell yet: even the right token is refused.
		const early = new LineClient(port);
		clients.push(early);
		await early.ready();
		early.sendFrame({ v: 1, kind: "hello", token: server.token, cell: "cell-1" });
		await early.closed();

		server.beginCell({ cellId: "cell-1", code: "" });

		const badToken = new LineClient(port);
		clients.push(badToken);
		await badToken.ready();
		badToken.sendFrame({ v: 1, kind: "hello", token: "0".repeat(64), cell: "cell-1" });
		await badToken.closed();

		const badCell = new LineClient(port);
		clients.push(badCell);
		await badCell.ready();
		badCell.sendFrame({ v: 1, kind: "hello", token: server.token, cell: "other-cell" });
		await badCell.closed();
	});

	it("drops connections that send frames before a successful handshake", async () => {
		const server = makeServer({ handlers: { noop: async () => ({}) } });
		await server.start();
		server.beginCell({ cellId: "cell-1", code: "" });

		const client = new LineClient(Number(server.address.split(":")[1]));
		clients.push(client);
		await client.ready();
		client.sendFrame({ v: 1, kind: "req", id: 1, type: "noop" });
		await client.closed();
	});

	it("drops connections on malformed JSON", async () => {
		const server = makeServer({ handlers: {} });
		await server.start();
		server.beginCell({ cellId: "cell-1", code: "" });

		const client = await handshake(server);
		clients.push(client);
		client.write("this is not json\n");
		await client.closed();
	});

	it("returns an error res for unknown request types and thrown handlers", async () => {
		const server = makeServer({
			handlers: {
				explode: async () => {
					throw new Error("boom");
				},
			},
		});
		await server.start();
		server.beginCell({ cellId: "cell-1", code: "" });

		const client = await handshake(server);
		clients.push(client);
		client.sendFrame({ v: 1, kind: "req", id: 1, type: "nope.missing" });
		expect(await client.nextFrame()).toEqual({
			v: 1,
			kind: "res",
			id: 1,
			status: "error",
			error: 'host request type "nope.missing" is not available in this session',
		});
		client.sendFrame({ v: 1, kind: "req", id: 2, type: "explode" });
		expect(await client.nextFrame()).toEqual({
			v: 1,
			kind: "res",
			id: 2,
			status: "error",
			error: "boom",
		});
	});

	it("parses frames split across writes and multiple frames per write", async () => {
		const server = makeServer({ handlers: { echo: async (payload) => ({ got: payload.n }) } });
		await server.start();
		server.beginCell({ cellId: "cell-1", code: "" });

		const client = await handshake(server);
		clients.push(client);
		const first = JSON.stringify({ v: 1, kind: "req", id: 1, type: "echo", payload: { n: 1 } });
		const second = JSON.stringify({ v: 1, kind: "req", id: 2, type: "echo", payload: { n: 2 } });
		client.write(first.slice(0, 10));
		await new Promise((resolve) => setTimeout(resolve, 20));
		client.write(`${first.slice(10)}\n${second}\n`);

		const results = [await client.nextFrame(), await client.nextFrame()] as Array<{ id: number }>;
		expect(results.map((frame) => frame.id).sort()).toEqual([1, 2]);
	});

	it("acks emits and routes display payloads to the cell sinks", async () => {
		const diffs: CellDiffDisplay[] = [];
		const attachments: CellAttachment[] = [];
		const server = makeServer({ handlers: {} });
		await server.start();
		server.beginCell({
			cellId: "cell-1",
			code: "",
			sinks: {
				onDiff: (diff) => diffs.push(diff),
				onAttachment: (attachment) => attachments.push(attachment),
			},
		});

		const client = await handshake(server);
		clients.push(client);
		client.sendFrame({
			v: 1,
			kind: "emit",
			id: 1,
			type: "display.diff",
			payload: { path: "src/a.rs", oldStr: "a", newStr: "b" },
		});
		expect(await client.nextFrame()).toEqual({ v: 1, kind: "ack", id: 1 });

		client.sendFrame({
			v: 1,
			kind: "emit",
			id: 2,
			type: "display.attachment",
			payload: { mimeType: "image/png", data: "aGk=", path: "shot.png" },
		});
		expect(await client.nextFrame()).toEqual({ v: 1, kind: "ack", id: 2 });

		// Unknown emit types are acked and skipped (forward compatibility).
		client.sendFrame({ v: 1, kind: "emit", id: 3, type: "display.future", payload: {} });
		expect(await client.nextFrame()).toEqual({ v: 1, kind: "ack", id: 3 });

		expect(diffs).toEqual([{ path: "src/a.rs", oldStr: "a", newStr: "b" }]);
		expect(attachments).toEqual([{ mimeType: "image/png", data: "aGk=", path: "shot.png" }]);
	});

	it("synthesizes sentAgentMessage receipts from agent_message.send results", async () => {
		const receipts: CellSentAgentMessage[] = [];
		const server = makeServer({
			handlers: {
				"agent_message.send": async (payload) =>
					payload.target === "all"
						? {
								receipts: [
									{
										id: "m1",
										message: "hi",
										deliveryStatus: "delivered",
										receiverRole: "child",
										target: { activeSessionId: "a1", sessionId: "s1", sessionName: "kid" },
									},
									{ target: "kid-2", error: "unreachable" },
								],
							}
						: {
								id: "m2",
								message: "hello parent",
								deliveryStatus: "queued",
								target: { activeSessionId: "a2", sessionId: "s2" },
							},
			},
		});
		await server.start();
		server.beginCell({
			cellId: "cell-1",
			code: "",
			sinks: { onSentAgentMessage: (receipt) => receipts.push(receipt) },
		});

		const client = await handshake(server);
		clients.push(client);
		client.sendFrame({
			v: 1,
			kind: "req",
			id: 1,
			type: "agent_message.send",
			payload: { target: "all", message: "hi" },
		});
		await client.nextFrame();
		client.sendFrame({
			v: 1,
			kind: "req",
			id: 2,
			type: "agent_message.send",
			payload: { message: "hello parent", receiver_role: "parent", receiver_name: null },
		});
		await client.nextFrame();

		expect(receipts).toEqual([
			{
				id: "m1",
				message: "hi",
				deliveryStatus: "delivered",
				receiverRole: "child",
				target: { activeSessionId: "a1", sessionId: "s1", sessionName: "kid" },
			},
			{
				id: "m2",
				message: "hello parent",
				deliveryStatus: "queued",
				// receiver_role from the request payload backfills the receipt.
				receiverRole: "parent",
				target: { activeSessionId: "a2", sessionId: "s2" },
			},
		]);
	});

	it("endCell waits for in-flight handlers and then drops guest connections", async () => {
		let release: (() => void) | undefined;
		let handlerDone = false;
		const server = makeServer({
			handlers: {
				slow: async () => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					handlerDone = true;
					return {};
				},
			},
		});
		await server.start();
		server.beginCell({ cellId: "cell-1", code: "" });

		const client = await handshake(server);
		clients.push(client);
		client.sendFrame({ v: 1, kind: "req", id: 1, type: "slow" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(release).toBeDefined();

		const ended = server.endCell();
		let endResolved = false;
		void ended.then(() => {
			endResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(endResolved).toBe(false);

		release?.();
		await ended;
		expect(handlerDone).toBe(true);
		await client.closed();

		// A fresh cell scope accepts a fresh handshake on the same server.
		server.beginCell({ cellId: "cell-2", code: "" });
		const next = await handshake(server, "cell-2");
		clients.push(next);
	});

	it("rejects overlapping cell scopes", async () => {
		const server = makeServer({ handlers: {} });
		await server.start();
		server.beginCell({ cellId: "cell-1", code: "" });
		expect(() => server.beginCell({ cellId: "cell-2", code: "" })).toThrow(/already active/);
	});
});

/** Minimal PNG writer (RGBA8, no interlace) so the thumbnail test has a real
 * decodable image without fixture files. */
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const chunk = new Uint8Array(12 + data.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, data.length);
	chunk.set(new TextEncoder().encode(type), 4);
	chunk.set(data, 8);
	view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
	return chunk;
}

function makeNoisePng(width: number, height: number): Buffer {
	const raw = new Uint8Array(height * (1 + width * 4));
	let seed = 0x12345678;
	const nextByte = () => {
		// xorshift32: the low byte of a plain LCG cycles fast enough for zlib
		// to flatten the "noise", defeating the size assertions.
		seed ^= seed << 13;
		seed >>>= 0;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		seed >>>= 0;
		return (seed >>> 24) & 0xff;
	};
	for (let y = 0; y < height; y++) {
		const row = y * (1 + width * 4);
		raw[row] = 0; // filter: none
		for (let i = 1; i < 1 + width * 4; i++) {
			raw[row + i] = nextByte();
		}
	}
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	const idat = new Uint8Array(zlib.deflateSync(raw));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", idat),
		pngChunk("IEND", new Uint8Array(0)),
	]);
}

describe("attachment thumbnailing (host-side, DESIGN §2.9)", () => {
	const servers: BridgeServer[] = [];
	afterEach(async () => {
		while (servers.length > 0) await servers.pop()?.dispose();
	});

	function makeServer(): { server: BridgeServer; attachments: CellAttachment[] } {
		const attachments: CellAttachment[] = [];
		const server = new BridgeServer({ handlers: {} });
		servers.push(server);
		return { server, attachments };
	}

	it("thumbnails oversized images down to the context budget before sinking", async () => {
		const photon = await loadPhoton();
		if (!photon) return; // photon unavailable in this environment; covered in CI images that ship it

		const { server, attachments } = makeServer();
		await server.start();
		server.beginCell({ cellId: "cell-1", code: "", sinks: { onAttachment: (a) => attachments.push(a) } });
		const client = await handshake(server);

		const bigPng = makeNoisePng(2000, 1400).toString("base64");
		expect(bigPng.length).toBeGreaterThan(350_000);
		client.sendFrame({
			v: 1,
			kind: "emit",
			id: 2,
			type: "display.attachment",
			payload: { mimeType: "image/png", data: bigPng, path: "big.png" },
		});
		expect(await client.nextFrame(15_000)).toEqual({ v: 1, kind: "ack", id: 2 });

		expect(attachments).toHaveLength(1);
		expect(attachments[0]?.path).toBe("big.png");
		expect(attachments[0]?.data.length).toBeLessThanOrEqual(350_000);
		client.destroy();
	});

	it("acks with an error when an oversized attachment cannot be processed", async () => {
		const { server, attachments } = makeServer();
		await server.start();
		server.beginCell({ cellId: "cell-1", code: "", sinks: { onAttachment: (a) => attachments.push(a) } });
		const client = await handshake(server);

		const garbage = Buffer.alloc(400_000, 7).toString("base64");
		client.sendFrame({
			v: 1,
			kind: "emit",
			id: 2,
			type: "display.attachment",
			payload: { mimeType: "image/png", data: garbage, path: "junk.png" },
		});
		const ack = (await client.nextFrame(15_000)) as Record<string, unknown>;
		expect(ack.kind).toBe("ack");
		expect(ack.id).toBe(2);
		expect(String(ack.error)).toContain("downscale");
		expect(attachments).toHaveLength(0);

		// The connection survives a rejected attachment (host-reported error).
		client.sendFrame({
			v: 1,
			kind: "emit",
			id: 3,
			type: "display.attachment",
			payload: { mimeType: "image/png", data: "aGk=", path: "ok.png" },
		});
		expect(await client.nextFrame(15_000)).toEqual({ v: 1, kind: "ack", id: 3 });
		expect(attachments).toHaveLength(1);
		client.destroy();
	});
});
