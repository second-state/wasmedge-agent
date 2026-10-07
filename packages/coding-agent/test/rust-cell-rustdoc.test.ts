import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import * as cellProcess from "../src/core/rust-cell/process.js";
import { createRustdocHandler } from "../src/core/rust-cell/rustdoc.js";
import * as rustdocCache from "../src/core/rust-cell/rustdoc-cache.js";
import {
	normalizeRustdocToolchain,
	RUSTDOC_CACHE_PATH,
	readRustdocCache,
} from "../src/core/rust-cell/rustdoc-cache.js";
import { indexRustdoc, RUSTDOC_TEST_TOOLCHAIN } from "../src/core/rust-cell/rustdoc-index.js";
import { findCargoBin } from "../src/core/rust-cell/toolchain.js";
import { listPersistentState, syncRustSkills } from "../src/core/rust-cell/workspace.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createRustToolDefinition } from "../src/core/tools/rust.js";
import { hasRustdocToolchain } from "./fixtures/rustdoc.js";

const roots: string[] = [];
const source = readFileSync(new URL("./fixtures/rustdoc-library.rs", import.meta.url), "utf8");
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const workspace = mkdtempSync(join(tmpdir(), "rustdoc-test-"));
	roots.push(workspace);
	writeFileSync(
		join(workspace, "Cargo.toml"),
		'[workspace]\nmembers = ["agent_lib", "rlm", "cell"]\nresolver = "2"\n[profile.dev.package."*"]\ndebug = false\n',
	);
	for (const name of ["agent_lib", "rlm", "cell", "skills/test_skill"]) {
		mkdirSync(join(workspace, name, "src"), { recursive: true });
		writeFileSync(
			join(workspace, name, "Cargo.toml"),
			`[package]\nname = "${name.split("/").at(-1)}"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\n`,
		);
	}
	writeFileSync(join(workspace, "agent_lib/src/lib.rs"), source);
	writeFileSync(join(workspace, "rlm/src/lib.rs"), "pub fn runtime_function() {}\n");
	writeFileSync(join(workspace, "cell/src/main.rs"), "fn main() {}\n");
	const skill = join(workspace, "skills/test_skill");
	writeFileSync(join(skill, "src/lib.rs"), "pub fn skill_function(value: u32) -> u32 { value }\n");
	syncRustSkills(workspace, [
		{ name: "test", crateName: "test_skill", cratePath: skill, cargoTomlPath: join(skill, "Cargo.toml") },
	]);
	execFileSync(findCargoBin(), ["generate-lockfile", "--offline"], { cwd: workspace, stdio: "pipe" });
	const handler = createRustdocHandler({ workspace, toolchain: RUSTDOC_TEST_TOOLCHAIN, timeoutMs: 60_000 });
	const query = (path: string, mode = "describe", offset = 0) =>
		handler({ path, mode, offset }, { signal: new AbortController().signal });
	return { workspace, handler, query };
}

describe("rustdoc configuration", () => {
	it("defaults off and exposes configured SDK policy", () => {
		expect(normalizeRustdocToolchain(null)).toBeUndefined();
		expect(SettingsManager.inMemory({}).getRustCellRustdocToolchain()).toBeUndefined();
		expect(
			SettingsManager.inMemory({
				rustCell: { rustdocToolchain: RUSTDOC_TEST_TOOLCHAIN },
			}).getRustCellRustdocToolchain(),
		).toBe(RUSTDOC_TEST_TOOLCHAIN);
		const provisioner = new RustCellProvisioner({ cwd: "/unused", rustdocToolchain: RUSTDOC_TEST_TOOLCHAIN });
		expect(createRustToolDefinition("/unused", { provisioner, rustdocToolchain: null }).description).toContain(
			"rlm::api::describe",
		);
		expect(createRustToolDefinition("/unused").description).not.toContain("rlm::api::describe");
	});
	it.each([false, 1, {}, "", "-nightly", "nightly --install", "../nightly"])(
		"rejects invalid setting %j",
		(invalid) => {
			expect(() => normalizeRustdocToolchain(invalid)).toThrow("rustCell.rustdocToolchain");
		},
	);
	it("rejects unsupported rustdoc formats", () => {
		expect(() => indexRustdoc({ agent_lib: { format_version: -1 } })).toThrow("Unsupported rustdoc JSON format");
	});
	it("requires an active context and explicit configuration without invoking tools", async () => {
		const run = vi.spyOn(cellProcess, "runProcess");
		const handler = createRustdocHandler({ workspace: "/unused", timeoutMs: 1000 });
		await expect(handler({ path: "agent_lib" })).rejects.toThrow("active cell");
		await expect(handler({ path: "agent_lib" }, { signal: new AbortController().signal })).rejects.toThrow(
			"disabled",
		);
		expect(run).not.toHaveBeenCalled();
	});
});

describe.skipIf(!hasRustdocToolchain())("rustdoc JSON against the WASI target", () => {
	it("resolves aliases, fields, methods, traits, variants, macros, cfg and mounted skills", {
		timeout: 120_000,
	}, async () => {
		const f = fixture();
		await f.query("agent_lib", "list");
		const cached = readRustdocCache(f.workspace, ["test_skill"])!;
		const paths = cached.items.map((item) => item.path);
		for (const path of [
			"Entry::value",
			"Entry::get",
			"Entry::CAP",
			"Reader::Item",
			"Reader::read",
			"Status::Value::0",
			"Status::Named::code",
			"helpers::Nested::get",
			"globbed::Record::new",
			"expanded",
			"wasi_only",
			"skills::test_skill::skill_function",
		]) {
			expect(paths).toContain(`agent_lib::${path}`);
		}
		expect(paths).toContain("rlm::runtime_function");
		expect(paths).toContain("agent_lib::r#type");
		expect(
			cached.items
				.filter((item) => item.path === "agent_lib::Shared")
				.map((item) => item.kind)
				.sort(),
		).toEqual(["function", "struct"]);
		const shadow = await f.query("agent_lib::shadow::parse");
		expect(shadow.items).toHaveLength(1);
		expect(shadow).toMatchObject({
			items: [{ declaration: { function: { sig: { inputs: [], output: { primitive: "u32" } } } } }],
		});
		expect(paths.some((path) => /secret|private_method|native_only|::hidden::/.test(path))).toBe(false);
		expect(cached.items.find((item) => item.path === "agent_lib::external")?.kind).toBe("module");
		expect(cached.items.some((item) => item.kind === "external_reexport")).toBe(true);
		const method = await f.query("agent_lib::Entry::get");
		expect(method).toMatchObject({
			source: "rustdoc-json",
			items: [
				{
					context: { generics: { params: [{ name: "T" }] } },
					declaration: { function: { sig: { output: { borrowed_ref: { type: { generic: "T" } } } } } },
				},
			],
		});
		const fn = await f.query("agent_lib::parse");
		expect(fn).toMatchObject({
			items: [{ declaration: { function: { generics: { params: [{ name: "'a" }, { name: "T" }] } } } }],
		});
		expect(JSON.stringify(method)).not.toContain(f.workspace);
		expect(listPersistentState(f.workspace)).toMatchObject({
			libApi: { source: "rustdoc-json" },
			libFunctions: expect.arrayContaining(["Entry::get", "skills::test_skill::skill_function"]),
		});
	});

	it("reuses only source- and toolchain-matched caches, including after source rollback", {
		timeout: 120_000,
	}, async () => {
		const f = fixture();
		await f.query("agent_lib::Entry");
		const run = vi.spyOn(cellProcess, "runProcess");
		await f.query("agent_lib::Reader");
		expect(run.mock.calls.some(([, args]) => args.includes("doc"))).toBe(false);
		const file = join(f.workspace, "agent_lib/src/lib.rs");
		writeFileSync(file, `${source}\npub struct Changed;\n`);
		expect(listPersistentState(f.workspace).libApi).toBeUndefined();
		writeFileSync(file, source);
		expect(listPersistentState(f.workspace).libApi).toBeDefined();
		writeFileSync(file, `${source}\npub struct Changed;\n`);
		await expect(f.query("agent_lib::Changed")).resolves.toMatchObject({ items: [{ kind: "struct" }] });
		expect(run.mock.calls.some(([, args]) => args.includes("doc"))).toBe(true);
		writeFileSync(join(f.workspace, "skills/test_skill/src/lib.rs"), "pub fn replacement() {}\n");
		expect(listPersistentState(f.workspace).libApi).toBeUndefined();
		await expect(f.query("agent_lib::skills::test_skill::replacement")).resolves.toMatchObject({
			items: [{ kind: "function" }],
		});
		const cachePath = join(f.workspace, RUSTDOC_CACHE_PATH);
		const cache = JSON.parse(readFileSync(cachePath, "utf8"));
		writeFileSync(cachePath, JSON.stringify({ ...cache, rustcVersion: "old compiler" }));
		run.mockClear();
		await f.query("agent_lib::Changed");
		expect(run.mock.calls.some(([, args]) => args.includes("doc"))).toBe(true);
	});

	it("paginates lists and rejects invalid inputs without compiling", { timeout: 120_000 }, async () => {
		const f = fixture();
		writeFileSync(
			join(f.workspace, "agent_lib/src/lib.rs"),
			`${source}\n${Array.from({ length: 65 }, (_, i) => `pub fn function_${i}() {}`).join("\n")}`,
		);
		const first = await f.query("agent_lib", "list");
		expect(first.items).toHaveLength(50);
		expect(first.nextOffset).toBe(50);
		const second = await f.query("agent_lib", "list", 50);
		expect(second.items).not.toEqual(first.items);
		const run = vi.spyOn(cellProcess, "runProcess");
		for (const input of [
			{ path: "../../secret" },
			{ path: "agent_lib", offset: -1 },
			{ path: "agent_lib", toolchain: "stable" },
			{ path: "agent_lib", mode: "bad" },
		]) {
			await expect(f.handler(input, { signal: new AbortController().signal })).rejects.toThrow();
		}
		expect(run).not.toHaveBeenCalled();
		await expect(f.query("agent_lib::unknown")).rejects.toThrow("No documented public API");

		const cachePath = join(f.workspace, RUSTDOC_CACHE_PATH);
		const cache = JSON.parse(readFileSync(cachePath, "utf8"));
		const item = { path: "agent_lib::Shared", kind: "function", docs: null, declaration: {} };
		writeFileSync(cachePath, JSON.stringify({ ...cache, items: Array.from({ length: 51 }, () => item) }));
		await expect(f.query("agent_lib::Shared")).resolves.toMatchObject({
			items: Array.from({ length: 51 }, () => item),
			nextOffset: null,
		});
		const large = { ...item, declaration: { signature: "x".repeat(20_000) } };
		writeFileSync(cachePath, JSON.stringify({ ...cache, items: [large, large] }));
		await expect(f.query("agent_lib::Shared")).rejects.toThrow("exceeds the response limit");
	});

	it.each(["live", "snapshot"])(
		"rejects %s source changes during generation",
		{ timeout: 120_000 },
		async (changed) => {
			const f = fixture();
			const original = cellProcess.runProcess;
			vi.spyOn(cellProcess, "runProcess").mockImplementation(async (bin, args, options) => {
				const result = await original(bin, args, options);
				if (args.includes("doc"))
					writeFileSync(
						join(changed === "live" ? f.workspace : options.cwd, "agent_lib/src/lib.rs"),
						`${source}\n// concurrently changed\n`,
					);
				return result;
			});
			await expect(f.query("agent_lib")).rejects.toThrow("Sources changed during");
			expect(existsSync(join(f.workspace, RUSTDOC_CACHE_PATH))).toBe(false);
		},
	);

	it("does not publish cache or change sources when rustdoc fails", { timeout: 120_000 }, async () => {
		const f = fixture();
		const broken = `${source}\npub fn broken(_: MissingType) {}`;
		writeFileSync(join(f.workspace, "agent_lib/src/lib.rs"), broken);
		await expect(f.query("agent_lib")).rejects.toThrow("Rustdoc introspection failed");
		expect(readFileSync(join(f.workspace, "agent_lib/src/lib.rs"), "utf8")).toBe(broken);
		expect(existsSync(join(f.workspace, RUSTDOC_CACHE_PATH))).toBe(false);
	});

	it("does not publish cache when cancelled after the final source scan", { timeout: 120_000 }, async () => {
		const f = fixture();
		const controller = new AbortController();
		const original = rustdocCache.rustdocFingerprintAsync;
		let liveScans = 0;
		vi.spyOn(rustdocCache, "rustdocFingerprintAsync").mockImplementation(async (...args) => {
			const fingerprint = await original(...args);
			if (args[0] === f.workspace && ++liveScans === 2) controller.abort(new Error("cancel final scan"));
			return fingerprint;
		});
		await expect(f.handler({ path: "agent_lib" }, { signal: controller.signal })).rejects.toThrow(
			"cancel final scan",
		);
		expect(liveScans).toBe(2);
		expect(existsSync(join(f.workspace, RUSTDOC_CACHE_PATH))).toBe(false);
	});

	it("bounds generation time and never installs a missing toolchain", { timeout: 120_000 }, async () => {
		const f = fixture();
		const missing = createRustdocHandler({
			workspace: f.workspace,
			toolchain: "missing-rustdoc-toolchain",
			timeoutMs: 1000,
		});
		await expect(missing({ path: "agent_lib" }, { signal: new AbortController().signal })).rejects.toThrow(
			"Rustdoc introspection failed",
		);
		const original = cellProcess.runProcess;
		let running = false;
		vi.spyOn(cellProcess, "runProcess").mockImplementation((bin, args, options) => {
			if (!args.includes("doc")) return original(bin, args, options);
			running = true;
			return original(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
		});
		const short = createRustdocHandler({
			workspace: f.workspace,
			toolchain: RUSTDOC_TEST_TOOLCHAIN,
			timeoutMs: 1000,
		});
		await expect(short({ path: "agent_lib" }, { signal: new AbortController().signal })).rejects.toThrow(
			/timeout|timed out/i,
		);
		expect(running).toBe(true);
		expect(existsSync(join(f.workspace, RUSTDOC_CACHE_PATH))).toBe(false);
	});

	it("aborts active generation and scrubs inherited compiler credentials", { timeout: 120_000 }, async () => {
		const f = fixture();
		const controller = new AbortController();
		vi.stubEnv("API_DOC_SECRET", "do-not-pass");
		vi.stubEnv("RUSTC", "/invalid-compiler");
		const original = cellProcess.runProcess;
		vi.spyOn(cellProcess, "runProcess").mockImplementation((bin, args, options) => {
			expect(options.env).not.toHaveProperty("API_DOC_SECRET");
			expect(options.env).not.toHaveProperty("RUSTC");
			const result = original(bin, args, options);
			if (args.includes("doc")) controller.abort(new Error("cancel docs"));
			return result;
		});
		await expect(f.handler({ path: "agent_lib" }, { signal: controller.signal })).rejects.toThrow("cancel docs");
		expect(existsSync(join(f.workspace, RUSTDOC_CACHE_PATH))).toBe(false);
	});
});
