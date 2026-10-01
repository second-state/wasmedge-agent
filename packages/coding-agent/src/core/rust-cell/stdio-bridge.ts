import { Duplex, type Writable } from "node:stream";

export const MAX_BRIDGE_FRAME_BYTES = 32 * 1024 * 1024;

export function stdioBridgePrefix(token: string): Buffer {
	return Buffer.from(`\x1eRLM:${token}:`);
}

/** Separate bridge frames from ordinary stdout, including partial UTF-8 and
 * markers split across process chunks. Only stdin carries host replies. */
export class StdioBridge {
	readonly connection: Duplex;
	private readonly prefix: Buffer;
	private pending: Buffer = Buffer.alloc(0);
	private frame: Buffer[] | undefined;
	private frameBytes = 0;
	private closed = false;

	constructor(
		input: Writable,
		token: string,
		private readonly onOutput: (data: Buffer) => void,
		private readonly onError: (error: Error) => void,
		private readonly maxFrameBytes = MAX_BRIDGE_FRAME_BYTES,
	) {
		this.prefix = stdioBridgePrefix(token);
		this.connection = new Duplex({
			read() {},
			write(chunk, _encoding, callback) {
				input.write(chunk, callback);
			},
			destroy(error, callback) {
				input.destroy();
				callback(error);
			},
		});
		this.connection.on("error", (error: Error) => {
			if (!this.closed) this.onError(error);
		});
		this.connection.on("close", () => {
			if (!this.closed) this.onError(new Error("stdio bridge connection closed"));
		});
		input.on("error", (error: Error) => this.connection.destroy(error));
	}

	write(data: Buffer): void {
		if (this.closed || this.connection.destroyed) return;
		let chunk = this.pending.length ? Buffer.concat([this.pending, data]) : data;
		this.pending = Buffer.alloc(0);
		while (chunk.length > 0) {
			if (this.frame) {
				const newline = chunk.indexOf(10);
				const part = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
				this.frameBytes += part.length;
				if (this.frameBytes > this.maxFrameBytes) {
					this.connection.destroy(new Error("stdio bridge frame exceeds the line-length limit"));
					return;
				}
				this.frame.push(part);
				if (newline < 0) return;
				const frame = Buffer.concat(this.frame, this.frameBytes);
				this.frame = undefined;
				this.frameBytes = 0;
				this.connection.push(frame);
				if (this.connection.destroyed) return;
				chunk = chunk.subarray(newline + 1);
			} else {
				const marker = chunk.indexOf(this.prefix);
				if (marker >= 0) {
					if (marker) this.onOutput(chunk.subarray(0, marker));
					this.frame = [];
					chunk = chunk.subarray(marker + this.prefix.length);
				} else {
					let held = Math.min(chunk.length, this.prefix.length - 1);
					while (held > 0 && !chunk.subarray(chunk.length - held).equals(this.prefix.subarray(0, held))) held--;
					if (chunk.length > held) this.onOutput(chunk.subarray(0, chunk.length - held));
					if (held) this.pending = Buffer.from(chunk.subarray(chunk.length - held));
					return;
				}
			}
		}
	}

	finish(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.frame) this.onError(new Error("stdio bridge ended with an incomplete frame"));
		else if (this.pending.length) this.onOutput(this.pending);
		this.pending = Buffer.alloc(0);
		this.frame = undefined;
		this.connection.destroy();
	}
}
