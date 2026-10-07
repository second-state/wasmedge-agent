import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProvisioningContext } from "../src/core/rust-cell/provisioning.js";
import { copyWorkspacePath, hashWorkspaceFile } from "../src/core/rust-cell/workspace-files.js";

vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }));

const roots: string[] = [];
const contexts: ProvisioningContext[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const context of contexts.splice(0)) context.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "workspace-files-"));
	roots.push(root);
	const controller = new AbortController();
	const context = new ProvisioningContext(controller.signal, 10_000);
	contexts.push(context);
	return { root, controller, context };
}

describe("asynchronous workspace filesystem operations", () => {
	it("copies contents, timestamps and literal symlinks without blocking other host work", async () => {
		const f = fixture();
		const source = join(f.root, "source");
		const destination = join(f.root, "copy");
		mkdirSync(source);
		writeFileSync(join(source, "file"), "data");
		utimesSync(join(source, "file"), 1_700_000_000, 1_700_000_000);
		symlinkSync("file", join(source, "link"));
		let yielded = false;
		setImmediate(() => {
			yielded = true;
		});
		await copyWorkspacePath(source, destination, f.context);
		expect(yielded).toBe(true);
		expect(readFileSync(join(destination, "file"), "utf8")).toBe("data");
		expect(readlinkSync(join(destination, "link"))).toBe("file");
		expect(statSync(join(destination, "file")).mtimeMs).toBe(1_700_000_000_000);
	});

	it("stops copying further entries when the host cancels between files", async () => {
		const f = fixture();
		const source = join(f.root, "source");
		const destination = join(f.root, "copy");
		mkdirSync(source);
		for (let i = 0; i < 20; i++) writeFileSync(join(source, String(i)), "data");
		let visited = 0;
		await expect(
			copyWorkspacePath(source, destination, f.context, (path) => {
				if (path !== source && ++visited === 2) {
					setImmediate(() => f.controller.abort(new Error("copy cancelled")));
				}
				return true;
			}),
		).rejects.toThrow("copy cancelled");
		expect(visited).toBe(2);
		expect(readdirSync(destination).length).toBeLessThanOrEqual(2);
	});

	it("preserves the SHA-256 identity while hashing incrementally", async () => {
		const f = fixture();
		const file = join(f.root, "source");
		const contents = Buffer.alloc(256 * 1024, "a");
		writeFileSync(file, contents);
		expect(await hashWorkspaceFile(file, f.context)).toBe(createHash("sha256").update(contents).digest("hex"));
	});

	it("cancels during a streamed hash and closes its file before returning", async () => {
		const f = fixture();
		const file = join(f.root, "source");
		writeFileSync(file, Buffer.alloc(1024 * 1024, "a"));
		const createStream = fs.createReadStream;
		let stream: fs.ReadStream | undefined;
		vi.spyOn(fs, "createReadStream").mockImplementationOnce((path, options) => {
			stream = createStream(path, options);
			stream.once("data", () => f.controller.abort(new Error("hash cancelled")));
			return stream;
		});
		await expect(hashWorkspaceFile(file, f.context)).rejects.toThrow("hash cancelled");
		expect(stream?.bytesRead).toBeLessThan(1024 * 1024);
		expect(stream?.closed).toBe(true);
	});
});
