import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testRustCrate } from "../src/core/rust-cell/crate-tests.js";
import * as cellProcess from "../src/core/rust-cell/process.js";
import { createRustdocHandler } from "../src/core/rust-cell/rustdoc.js";
import {
	MAX_RUSTDOC_BYTES,
	RUSTDOC_CACHE_PATH,
	readRustdocCache,
	readRustdocCacheAsync,
	readRustdocJsonAsync,
	rustdocFingerprint,
	rustdocFingerprintAsync,
} from "../src/core/rust-cell/rustdoc-cache.js";
import { RUSTDOC_FORMAT_VERSION } from "../src/core/rust-cell/rustdoc-index.js";
import {
	skillSourceFingerprint,
	skillSourceFingerprintAsync,
	skillTestFingerprint,
	skillTestFingerprintAsync,
} from "../src/core/rust-cell/skill-fingerprint.js";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }));

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = fs.mkdtempSync(join(tmpdir(), "source-fingerprint-"));
	roots.push(root);
	const write = (path: string, content: string | Buffer = path) => {
		const file = join(root, path);
		fs.mkdirSync(dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		return file;
	};
	write("Cargo.toml", "[workspace]\n");
	write("agent_lib/Cargo.toml", "[package]\nname = 'agent_lib'\n");
	write("agent_lib/src/lib.rs", "pub fn helper() {}\n");
	write("cell/Cargo.toml");
	return { root, write };
}

function writeCache(root: string) {
	const cache = {
		schema: 1,
		formatVersion: RUSTDOC_FORMAT_VERSION,
		target: "wasm32-wasip1",
		toolchain: "nightly-test",
		rustcVersion: "rustc test",
		fingerprint: rustdocFingerprint(root, []),
		items: [{ path: "agent_lib", kind: "module", docs: null, declaration: {} }],
	};
	fs.mkdirSync(join(root, "target"), { recursive: true });
	fs.writeFileSync(join(root, RUSTDOC_CACHE_PATH), JSON.stringify(cache));
	return cache;
}

function abortDuringRead(file: string, controller: AbortController) {
	const createStream = fs.createReadStream;
	let active: fs.ReadStream | undefined;
	vi.spyOn(fs, "createReadStream").mockImplementation((path, options) => {
		const stream = createStream(path, options);
		if (path === file) {
			active = stream;
			stream.once("data", () => controller.abort(new Error("fingerprint cancelled")));
		}
		return stream;
	});
	return () => active;
}

describe("cancellable source fingerprints", () => {
	it("preserves synchronous identities, symlink content, executable bits and fixture coverage", async () => {
		const f = fixture();
		const file = f.write("agent_lib/fixtures/target/input", "fixture");
		fs.symlinkSync("fixtures", join(f.root, "agent_lib/linked-fixtures"));
		fs.symlinkSync("fixtures/target/input", join(f.root, "agent_lib/linked-file"));
		const fingerprint = () => skillSourceFingerprintAsync(f.root, ["agent_lib", "missing"]);
		let yielded = false;
		setImmediate(() => {
			yielded = true;
		});
		const original = await fingerprint();
		expect(yielded).toBe(true);
		expect(original).toBe(skillSourceFingerprint(f.root, ["agent_lib", "missing"]));
		f.write("agent_lib/target/build");
		f.write("agent_lib/.git/config");
		expect(await fingerprint()).toBe(original);
		fs.writeFileSync(file, "changed");
		const changed = await fingerprint();
		expect(changed).not.toBe(original);
		expect(changed).toBe(skillSourceFingerprint(f.root, ["agent_lib", "missing"]));
		fs.chmodSync(file, 0o755);
		expect(await fingerprint()).not.toBe(changed);
		expect(await fingerprint()).toBe(skillSourceFingerprint(f.root, ["agent_lib", "missing"]));
		f.write("missing");
		expect(await fingerprint()).toBe(skillSourceFingerprint(f.root, ["agent_lib", "missing"]));
	});

	it("keeps test and rustdoc hashes compatible while ignoring unmounted skills and cell code", async () => {
		const f = fixture();
		f.write("skills/z/src/lib.rs");
		f.write("skills/a/fixtures/target/input");
		f.write("skills/broken/notes");
		fs.symlinkSync("missing", join(f.root, "skills/broken/link"));
		const mounted = ["z", "a"];
		expect(await skillTestFingerprintAsync(f.root, mounted)).toBe(skillTestFingerprint(f.root, mounted));
		const docs = await rustdocFingerprintAsync(f.root, mounted);
		expect(docs).toBe(rustdocFingerprint(f.root, mounted));
		expect(await rustdocFingerprintAsync(f.root, [...mounted].reverse())).toBe(docs);
		f.write("cell/src/main.rs", "next cell");
		expect(await rustdocFingerprintAsync(f.root, mounted)).toBe(docs);
		f.write("cell/Cargo.toml", "changed dependencies");
		expect(await rustdocFingerprintAsync(f.root, mounted)).not.toBe(docs);
	});

	it.each(["dangling", "cycle"])("rejects a %s source link", async (kind) => {
		const f = fixture();
		fs.symlinkSync(kind === "cycle" ? "." : "missing", join(f.root, "agent_lib/link"));
		await expect(skillSourceFingerprintAsync(f.root)).rejects.toThrow(kind === "cycle" ? /symlink cycle/ : /ENOENT/);
	});

	it("rejects pre-cancelled scans without opening files", async () => {
		const f = fixture();
		const stream = vi.spyOn(fs, "createReadStream");
		const reason = new Error("already cancelled");
		await expect(skillSourceFingerprintAsync(f.root, undefined, AbortSignal.abort(reason))).rejects.toBe(reason);
		expect(stream).not.toHaveBeenCalled();
	});

	it("stops a large file read, closes it before rejecting and allows retry", async () => {
		const f = fixture();
		const file = f.write("large", Buffer.alloc(1024 * 1024, "a"));
		const controller = new AbortController();
		const stream = abortDuringRead(file, controller);
		await expect(skillSourceFingerprintAsync(f.root, ["large"], controller.signal)).rejects.toThrow(
			"fingerprint cancelled",
		);
		expect(stream()?.bytesRead).toBeLessThan(1024 * 1024);
		expect(stream()?.closed).toBe(true);
		vi.restoreAllMocks();
		expect(await skillSourceFingerprintAsync(f.root)).toBe(skillSourceFingerprint(f.root));
	});
});

describe("runtime fingerprint cancellation", () => {
	it.each(["tests", "rustdoc cache"])("stops %s before Cargo and preserves sources/cache", async (kind) => {
		const f = fixture();
		const file = f.write("agent_lib/fixtures/large", Buffer.alloc(1024 * 1024, "a"));
		const cache = writeCache(f.root);
		const controller = new AbortController();
		const stream = abortDuringRead(file, controller);
		const mktemp = vi.spyOn(fs, "mkdtempSync");
		const run = vi.spyOn(cellProcess, "runProcess").mockImplementation(async (_bin, args) => {
			if (!args.includes("--version")) throw new Error("must not start Cargo");
			return { exitCode: 0, stdout: "rustc test", stderr: "", timedOut: false, aborted: false };
		});
		const pending =
			kind === "tests"
				? testRustCrate("agent_lib", {
						workspaceDir: f.root,
						cargoBin: "unused",
						wasmedgeBin: "unused",
						timeoutMs: 10_000,
						signal: controller.signal,
					})
				: createRustdocHandler({ workspace: f.root, toolchain: "nightly-test", timeoutMs: 10_000 })(
						{ path: "agent_lib" },
						{ signal: controller.signal },
					);
		await expect(pending).rejects.toThrow("fingerprint cancelled");
		expect(stream()?.closed).toBe(true);
		expect(run).toHaveBeenCalledTimes(kind === "tests" ? 0 : 1);
		for (const result of mktemp.mock.results) expect(fs.existsSync(result.value)).toBe(false);
		expect(fs.readFileSync(file).length).toBe(1024 * 1024);
		expect(JSON.parse(fs.readFileSync(join(f.root, RUSTDOC_CACHE_PATH), "utf8"))).toEqual(cache);
	});

	it("reuses existing cache identities and treats malformed or stale caches as misses", async () => {
		const f = fixture();
		const cache = writeCache(f.root);
		expect(await readRustdocCacheAsync(f.root, [])).toEqual(readRustdocCache(f.root, []));
		expect(await readRustdocCacheAsync(f.root, [])).toEqual(cache);
		f.write("agent_lib/src/lib.rs", "changed");
		expect(await readRustdocCacheAsync(f.root, [])).toBeUndefined();
		f.write(RUSTDOC_CACHE_PATH, "invalid json");
		expect(await readRustdocCacheAsync(f.root, [])).toBeUndefined();
		const reason = new Error("cancel cache read");
		await expect(readRustdocCacheAsync(f.root, [], AbortSignal.abort(reason))).rejects.toBe(reason);
	});

	it("retains the rustdoc JSON file-size limit", async () => {
		const f = fixture();
		const file = f.write("large.json", "{}");
		fs.truncateSync(file, MAX_RUSTDOC_BYTES + 1);
		await expect(readRustdocJsonAsync(file)).rejects.toThrow("32 MiB file limit");
	});
});
