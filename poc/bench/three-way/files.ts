import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function hashTree(
	root: string,
	excluded = new Set([".git", "node_modules", "target", "vendor", "results", "__pycache__", ".pytest_cache"]),
): string {
	const hash = createHash("sha256");
	const visit = (path: string, name: string) => {
		const info = lstatSync(path);
		if (info.isDirectory()) {
			hash.update(JSON.stringify(["directory", name]));
			for (const child of readdirSync(path).sort()) {
				if (!excluded.has(child)) visit(join(path, child), name ? `${name}/${child}` : child);
			}
		} else if (info.isFile()) {
			const bytes = readFileSync(path);
			hash.update(JSON.stringify(["file", name, info.mode & 0o111, bytes.length])).update(bytes);
		} else {
			throw new Error(`Unsupported source entry: ${path}`);
		}
	};
	visit(root, "");
	return hash.digest("hex");
}

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}

export function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`Invalid JSON record: ${path}`);
	}
}

/** Save paid output as it arrives while withholding a possible split secret. */
export class StreamArtifact {
	private pending = "";
	private readonly decoder = new TextDecoder();
	constructor(
		private readonly path: string,
		private readonly secret: string | null,
	) {
		writeFileSync(path, "", { mode: 0o600 });
	}
	push(chunk: Uint8Array, final = false): void {
		this.pending += this.decoder.decode(chunk, { stream: !final });
		if (this.secret) this.pending = this.pending.replaceAll(this.secret, "[REDACTED]");
		let boundary =
			final || !this.secret ? this.pending.length : Math.max(0, this.pending.length - this.secret.length + 1);
		if (
			boundary &&
			/[\uD800-\uDBFF]/.test(this.pending[boundary - 1]) &&
			/[\uDC00-\uDFFF]/.test(this.pending[boundary] ?? "")
		)
			boundary--;
		if (boundary) {
			appendFileSync(this.path, this.pending.slice(0, boundary), { mode: 0o600 });
			this.pending = this.pending.slice(boundary);
		}
	}
}
