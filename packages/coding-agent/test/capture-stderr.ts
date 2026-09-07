/**
 * Captures what reaches stderr's file descriptor.
 *
 * The startup warning path writes with writeSync on process.stderr.fd rather
 * than through the stream, so that the process.exit() following it cannot
 * abandon a buffered write -- see writeStderrSync in src/migrations.ts. A spy
 * on process.stderr.write therefore sees nothing. Pointing the descriptor at a
 * file is what a test can observe instead, and it observes the same thing a
 * shell redirect would.
 */

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StderrCapture {
	/** Everything written to the descriptor so far. */
	read(): string;
	/** Forgets what has been written, for a test with two runs to compare. */
	reset(): void;
	restore(): void;
}

export function captureStderr(): StderrCapture {
	const dir = mkdtempSync(join(tmpdir(), "stderr-capture-"));
	const path = join(dir, "stderr");
	let fd = openSync(path, "w");
	const real = process.stderr;
	// Prototype-chained rather than a bare object, so anything else reading
	// this stream during the test -- isTTY, columns -- still sees the real
	// values. write() is bound to the real stream so the fallback path inside
	// writeStderrSync stays a working write rather than a stream method
	// running against the wrong instance.
	const stub = Object.create(real, {
		fd: { value: fd, configurable: true },
		write: { value: real.write.bind(real), configurable: true },
	}) as typeof process.stderr;
	Object.defineProperty(process, "stderr", { value: stub, configurable: true });
	return {
		read: () => readFileSync(path, "utf8"),
		// Reopened rather than truncated: truncating leaves the descriptor's
		// write position where it was, and the next write would pad the gap
		// with zero bytes rather than start the file again.
		reset() {
			closeSync(fd);
			fd = openSync(path, "w");
			Object.defineProperty(stub, "fd", { value: fd, configurable: true });
		},
		restore() {
			Object.defineProperty(process, "stderr", { value: real, configurable: true });
			closeSync(fd);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
