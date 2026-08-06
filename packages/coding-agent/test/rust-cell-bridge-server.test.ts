import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { KernelAttachment, KernelDiffDisplay, KernelSentAgentMessage } from "../src/core/host-bridge/types.js";
import { BridgeServer } from "../src/core/rust-cell/bridge-server.js";

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
		const diffs: KernelDiffDisplay[] = [];
		const attachments: KernelAttachment[] = [];
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
		const receipts: KernelSentAgentMessage[] = [];
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
