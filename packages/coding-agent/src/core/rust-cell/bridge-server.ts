/** Host bridge protocol v1 (DESIGN.md §2.7): a loopback TCP listener speaking
 * newline-delimited JSON with a per-session bearer token. Guest cells connect
 * via wasmedge's WASI socket extension and send typed host requests (`req`,
 * answered from the HostRequestHandlers registry) and rich-output events
 * (`emit`, acked for backpressure). One cell is in scope at a time — cells are
 * serialized — and its source code is injected into every handler payload for
 * subagent spawn attribution, mirroring the kernel-era handleHostRequest. */

import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type {
	CellAttachment,
	CellDiffDisplay,
	CellSentAgentMessage,
	HostRequestHandlers,
} from "../host-bridge/types.js";

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Wait budget for in-flight handlers when a cell ends (kernel-era
 * HOST_REQUEST_DISPOSE_TIMEOUT_MS). */
const IN_FLIGHT_SETTLE_TIMEOUT_MS = 5000;

/** Frame guard: attachments are base64 ≤ 28 MiB on the wire, so any
 * well-formed line fits. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Hard cap on attachment payloads (base64 chars), per DESIGN.md §2.9. */
/** Wire cap for attachment payloads; the host thumbnails before sinking. */
const MAX_ATTACHMENT_WIRE_CHARS = 28 * 1024 * 1024;
/** Context budget for a sunk attachment (base64 chars), DESIGN.md §2.9. */
const MAX_ATTACHMENT_SINK_CHARS = 350_000;
const MAX_ATTACHMENT_DIMENSION = 1200;

export interface BridgeEmitSinks {
	onDiff?: (diff: CellDiffDisplay) => void;
	onAttachment?: (attachment: CellAttachment) => void;
	onSentAgentMessage?: (message: CellSentAgentMessage) => void;
}

export interface BridgeCellScope {
	/** Tool-call id; the guest echoes it in the handshake (RLM_CELL_ID). */
	cellId: string;
	/** Cell source, injected as `cellSourceCode` into handler payloads. */
	code: string;
	sinks?: BridgeEmitSinks;
}

export interface BridgeServerOptions {
	handlers: HostRequestHandlers;
	onDiagnostic?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseSentAgentMessage(payload: unknown): CellSentAgentMessage | undefined {
	if (!isRecord(payload) || !isRecord(payload.target)) {
		return undefined;
	}
	const { id, message, deliveryStatus, receiverRole, target } = payload;
	const { activeSessionId, sessionId, sessionName } = target;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued") ||
		typeof activeSessionId !== "string" ||
		typeof sessionId !== "string"
	) {
		return undefined;
	}
	return {
		id,
		message,
		deliveryStatus,
		...(receiverRole === "parent" || receiverRole === "sibling" || receiverRole === "child" ? { receiverRole } : {}),
		target: {
			activeSessionId,
			sessionId,
			...(typeof sessionName === "string" ? { sessionName } : {}),
		},
	};
}

export class BridgeServer {
	private readonly handlers: HostRequestHandlers;
	private readonly onDiagnostic?: (message: string) => void;
	private readonly bearerToken = randomBytes(32).toString("hex");
	private server?: Server;
	private port?: number;
	private starting?: Promise<void>;
	private scope?: BridgeCellScope;
	private readonly sockets = new Set<Socket>();
	private readonly inFlight = new Set<Promise<void>>();

	constructor(options: BridgeServerOptions) {
		this.handlers = options.handlers;
		this.onDiagnostic = options.onDiagnostic;
	}

	/** 64-hex bearer token the guest must present in the handshake. */
	get token(): string {
		return this.bearerToken;
	}

	/** "127.0.0.1:<port>" once started. */
	get address(): string {
		if (this.port === undefined) {
			throw new Error("bridge server is not started");
		}
		return `127.0.0.1:${this.port}`;
	}

	get isStarted(): boolean {
		return this.port !== undefined;
	}

	/** Idempotent lazy listen on an ephemeral loopback port. */
	start(): Promise<void> {
		if (this.port !== undefined) return Promise.resolve();
		if (this.starting) return this.starting;
		this.starting = new Promise<void>((resolve, reject) => {
			const server = createServer((socket) => this.acceptConnection(socket));
			server.on("error", (error) => {
				if (this.port === undefined) {
					this.starting = undefined;
					reject(error);
					return;
				}
				this.diagnostic(`bridge server error: ${errorMessage(error)}`);
			});
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (addr === null || typeof addr === "string") {
					server.close();
					this.starting = undefined;
					reject(new Error("bridge server failed to bind a loopback port"));
					return;
				}
				this.server = server;
				this.port = addr.port;
				this.starting = undefined;
				resolve();
			});
		});
		return this.starting;
	}

	/** Enter a cell's scope. Cells are serialized; overlapping scopes are a bug. */
	beginCell(scope: BridgeCellScope): void {
		if (this.scope) {
			throw new Error(`bridge cell scope already active (${this.scope.cellId})`);
		}
		this.scope = scope;
	}

	/** Leave the cell scope: wait briefly for in-flight handlers (their side
	 * effects should land even though the reply has no reader anymore), then
	 * drop all guest connections. */
	async endCell(): Promise<void> {
		await this.waitForInFlight(IN_FLIGHT_SETTLE_TIMEOUT_MS);
		for (const socket of this.sockets) {
			socket.destroy();
		}
		this.sockets.clear();
		this.scope = undefined;
	}

	async dispose(): Promise<void> {
		await this.endCell();
		const server = this.server;
		this.server = undefined;
		this.port = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	private acceptConnection(socket: Socket): void {
		this.sockets.add(socket);
		socket.setNoDelay(true);
		let buffer = "";
		let authed = false;

		socket.on("data", (data: Buffer) => {
			buffer += data.toString("utf-8");
			if (Buffer.byteLength(buffer, "utf-8") > MAX_LINE_BYTES) {
				this.diagnostic("bridge connection dropped: frame exceeds the line-length limit");
				socket.destroy();
				return;
			}
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.trim()) {
					authed = this.handleLine(socket, line, authed);
					if (socket.destroyed) return;
				}
				newline = buffer.indexOf("\n");
			}
		});
		socket.on("error", () => {
			// Guest side went away mid-write; close handling is enough.
		});
		socket.on("close", () => {
			this.sockets.delete(socket);
		});
	}

	/** Returns the connection's new authed state. */
	private handleLine(socket: Socket, line: string, authed: boolean): boolean {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.diagnostic("bridge connection dropped: malformed JSON frame");
			socket.destroy();
			return authed;
		}
		if (!isRecord(message) || message.v !== BRIDGE_PROTOCOL_VERSION || typeof message.kind !== "string") {
			this.diagnostic("bridge connection dropped: invalid frame envelope");
			socket.destroy();
			return authed;
		}

		if (!authed) {
			if (
				message.kind !== "hello" ||
				message.token !== this.bearerToken ||
				typeof message.cell !== "string" ||
				message.cell !== this.scope?.cellId
			) {
				this.diagnostic("bridge connection dropped: handshake rejected");
				socket.destroy();
				return false;
			}
			this.send(socket, { v: BRIDGE_PROTOCOL_VERSION, kind: "hello_ok" });
			return true;
		}

		switch (message.kind) {
			case "req":
				this.handleRequest(socket, message);
				break;
			case "emit":
				this.handleEmit(socket, message);
				break;
			default:
				this.diagnostic(`bridge connection dropped: unsupported frame kind "${message.kind}"`);
				socket.destroy();
		}
		return true;
	}

	private handleRequest(socket: Socket, message: Record<string, unknown>): void {
		const id = message.id;
		if (typeof id !== "number") {
			this.diagnostic("bridge connection dropped: req frame without a numeric id");
			socket.destroy();
			return;
		}
		const task = (async () => {
			try {
				const payload = await this.dispatchRequest(message);
				this.send(socket, {
					v: BRIDGE_PROTOCOL_VERSION,
					kind: "res",
					id,
					status: "ok",
					payload,
				});
			} catch (error) {
				this.send(socket, {
					v: BRIDGE_PROTOCOL_VERSION,
					kind: "res",
					id,
					status: "error",
					error: errorMessage(error),
				});
			}
		})();
		this.inFlight.add(task);
		void task.finally(() => {
			this.inFlight.delete(task);
		});
	}

	private async dispatchRequest(message: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (typeof message.type !== "string" || message.type.length === 0) {
			throw new Error("host request payload must have a string type");
		}
		const scope = this.scope;
		if (!scope) {
			throw new Error("no cell is active on this bridge");
		}
		const handler = this.handlers[message.type];
		if (!handler) {
			throw new Error(`host request type "${message.type}" is not available in this session`);
		}
		const payload = isRecord(message.payload) ? message.payload : {};
		const result = await handler({ ...payload, cellSourceCode: scope.code });
		if (message.type === "agent_message.send") {
			this.collectSentAgentMessages(scope, result, payload);
		}
		return result;
	}

	/** The kernel collected receipts from an IPython display MIME the Python
	 * runtime emitted after each send; here the host synthesizes them from the
	 * handler result instead, so guests get receipts in CellResult for free. */
	private collectSentAgentMessages(
		scope: BridgeCellScope,
		result: Record<string, unknown>,
		requestPayload: Record<string, unknown>,
	): void {
		const sink = scope.sinks?.onSentAgentMessage;
		if (!sink) return;
		const candidates = Array.isArray(result.receipts) ? result.receipts : [result];
		const role = requestPayload.receiver_role;
		for (const candidate of candidates) {
			const withRole =
				isRecord(candidate) &&
				candidate.receiverRole === undefined &&
				(role === "parent" || role === "sibling" || role === "child")
					? { ...candidate, receiverRole: role }
					: candidate;
			const receipt = parseSentAgentMessage(withRole);
			if (receipt) sink(receipt);
		}
	}

	private handleEmit(socket: Socket, message: Record<string, unknown>): void {
		const id = message.id;
		if (typeof id !== "number") {
			this.diagnostic("bridge connection dropped: emit frame without a numeric id");
			socket.destroy();
			return;
		}
		const payload = isRecord(message.payload) ? message.payload : {};
		switch (message.type) {
			case "display.diff": {
				const diff = this.parseDiff(payload);
				if (diff) {
					this.scope?.sinks?.onDiff?.(diff);
				} else {
					this.diagnostic("bridge emit display.diff ignored: invalid payload");
				}
				break;
			}
			case "display.attachment": {
				// Async: thumbnail before sinking; the ack (with an optional error)
				// goes out only after processing, which also keeps backpressure.
				void this.processAttachment(socket, id, payload);
				return;
			}
			default:
				// Unknown emit types are acked and skipped so newer guests degrade softly.
				this.diagnostic(`bridge emit ignored: unknown type "${String(message.type)}"`);
		}
		this.send(socket, { v: BRIDGE_PROTOCOL_VERSION, kind: "ack", id });
	}

	/** Validate, thumbnail (≤1200px / ≤350K base64 via the host photon
	 * pipeline), sink, then ack — with an error field when the attachment
	 * cannot enter context, so the cell sees the failure. */
	private async processAttachment(socket: Socket, id: number, payload: Record<string, unknown>): Promise<void> {
		const ack = (error?: string) => {
			if (error) this.diagnostic(`bridge emit display.attachment rejected: ${error}`);
			this.send(socket, {
				v: BRIDGE_PROTOCOL_VERSION,
				kind: "ack",
				id,
				...(error ? { error } : {}),
			});
		};
		if (typeof payload.mimeType !== "string" || typeof payload.data !== "string") {
			ack("invalid attachment payload (mimeType/data)");
			return;
		}
		if (payload.data.length > MAX_ATTACHMENT_WIRE_CHARS) {
			ack(`attachment is ${payload.data.length} base64 chars (wire limit ${MAX_ATTACHMENT_WIRE_CHARS})`);
			return;
		}
		const path = typeof payload.path === "string" ? payload.path : undefined;
		let data = payload.data;
		let mimeType = payload.mimeType;
		try {
			// SVG passes through untouched (vector, no photon decode); everything
			// else goes through the resize pipeline for dimension/size budgeting.
			if (mimeType !== "image/svg+xml") {
				const { resizeImage } = await import("../../utils/image-resize.js");
				const resized = await resizeImage(
					{ type: "image", data, mimeType },
					{
						maxWidth: MAX_ATTACHMENT_DIMENSION,
						maxHeight: MAX_ATTACHMENT_DIMENSION,
						maxBytes: MAX_ATTACHMENT_SINK_CHARS,
					},
				);
				if (resized) {
					data = resized.data;
					mimeType = resized.mimeType;
				}
			}
		} catch (error) {
			ack(`attachment could not be processed: ${errorMessage(error)}`);
			return;
		}
		if (data.length > MAX_ATTACHMENT_SINK_CHARS) {
			ack(
				`attachment is ${data.length} base64 chars after processing (limit ${MAX_ATTACHMENT_SINK_CHARS}); ` +
					"the image could not be thumbnailed on this host — downscale it first",
			);
			return;
		}
		this.scope?.sinks?.onAttachment?.({ mimeType, data, ...(path ? { path } : {}) });
		ack();
	}

	private parseDiff(payload: Record<string, unknown>): CellDiffDisplay | undefined {
		if (
			typeof payload.path !== "string" ||
			typeof payload.oldStr !== "string" ||
			typeof payload.newStr !== "string"
		) {
			return undefined;
		}
		return {
			path: payload.path,
			oldStr: payload.oldStr,
			newStr: payload.newStr,
			...(typeof payload.startLine === "number" ? { startLine: payload.startLine } : {}),
		};
	}

	private send(socket: Socket, frame: Record<string, unknown>): void {
		if (socket.destroyed) return;
		try {
			socket.write(`${JSON.stringify(frame)}\n`);
		} catch (error) {
			this.diagnostic(`bridge reply failed: ${errorMessage(error)}`);
		}
	}

	private async waitForInFlight(timeoutMs: number): Promise<void> {
		if (this.inFlight.size === 0) return;
		const tasks = [...this.inFlight];
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
			timer.unref?.();
		});
		const outcome = await Promise.race([Promise.allSettled(tasks).then(() => "settled" as const), timeout]);
		if (timer) clearTimeout(timer);
		if (outcome === "timeout") {
			this.diagnostic(`timed out waiting ${timeoutMs}ms for ${tasks.length} bridge handler(s) at cell end`);
		}
	}

	private diagnostic(message: string): void {
		this.onDiagnostic?.(message);
	}
}
