import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyLib, listPersistentState, revertLib } from "../src/core/rust-cell/workspace.js";

describe("persistent workspace listing", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function workspace(files: Record<string, string> = {}): string {
		const dir = mkdtempSync(join(tmpdir(), "rust-state-listing-"));
		dirs.push(dir);
		for (const [path, source] of Object.entries({ "lib.rs": "pub mod helpers;", ...files })) {
			write(dir, `agent_lib/src/${path}`, source);
		}
		return dir;
	}

	function write(dir: string, path: string, text: string): void {
		const target = join(dir, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
	}

	it("follows public file and inline modules from the crate root", () => {
		const dir = workspace({
			"lib.rs": "pub mod helpers; pub fn root() {}",
			"helpers/mod.rs": "pub mod flat; pub mod nested; pub mod inline { pub mod child; pub fn local() {} }",
			"helpers/flat.rs": "pub mod child; pub fn direct() {}",
			"helpers/flat/child.rs": "pub fn leaf() {}",
			"helpers/nested/mod.rs": "pub mod child; pub fn direct() {}",
			"helpers/nested/child.rs": "pub fn leaf() {}",
			"helpers/inline/child.rs": "pub fn leaf() {}",
		});
		expect(listPersistentState(dir).libFunctions).toEqual([
			"helpers::flat::child::leaf",
			"helpers::flat::direct",
			"helpers::inline::child::leaf",
			"helpers::inline::local",
			"helpers::nested::child::leaf",
			"helpers::nested::direct",
			"root",
		]);
	});

	it("recognizes function qualifiers, generics, comments between tokens, and raw identifiers", () => {
		const dir = workspace({
			"helpers/mod.rs": `
pub async fn load_async() {}
pub const fn constant() -> usize { 1 }
pub unsafe extern "C" fn ffi() {}
pub /* comment */ fn generic<'a, T: Into<Vec<Vec<u8>>>>(x: &'a T) {}
pub fn r#match() {}
pub mod r#type { pub fn 中文() {} }
`,
		});
		expect(listPersistentState(dir).libFunctions).toEqual([
			"helpers::constant",
			"helpers::ffi",
			"helpers::generic",
			"helpers::load_async",
			"helpers::r#match",
			"helpers::r#type::中文",
		]);
	});

	it("does not invent free-function paths for methods or items inside bodies and macros", () => {
		const dir = workspace({
			"helpers/mod.rs": `
pub struct Counter;
impl Counter { pub fn new() -> Self { Self } pub fn value(&self) {} }
pub trait Trait { fn method(); }
impl Trait for Counter { fn method() {} }
pub fn outer() { pub fn local() {} }
macro_rules! declare { () => { pub fn generated() {} }; }
declare! { pub fn macro_input() {} }
declare!(pub fn more_input() {});
const CALLBACK: fn() = || { pub fn nested() {} };
`,
		});
		expect(listPersistentState(dir).libFunctions).toEqual(["helpers::outer"]);
	});

	it("ignores comments and literals without losing subsequent declarations", () => {
		const dir = workspace({
			"helpers/mod.rs": String.raw`
// pub fn line_comment() {}
/* outer /* nested */ pub fn block_comment() {} */
pub const TEXT: &str = "\"; pub fn string_literal() {}";
pub const RAW: &str = r###""; pub fn raw_literal() {} /*"###;
pub const BYTES: &[u8] = br#"pub fn byte_literal() {}"#;
pub const CHAR: char = '{';
pub const QUOTE: char = '\'';
#[doc = "pub fn doc_literal() {}"]
pub fn actual<'a>(s: &'a str) -> &'a str { s }
`,
		});
		expect(listPersistentState(dir).libFunctions).toEqual(["helpers::actual"]);
	});

	it("omits private, restricted, and undeclared modules and functions", () => {
		const dir = workspace({
			"helpers/mod.rs": `
mod hidden;
pub(crate) mod internal;
pub mod exposed;
pub(crate) fn crate_only() {}
pub(super) fn parent_only() {}
fn private() {}
pub use hidden::reexported;
`,
			"helpers/hidden.rs": "pub fn reexported() {}",
			"helpers/internal.rs": "pub fn internal() {}",
			"helpers/orphan.rs": "pub fn unused() {}",
			"helpers/exposed.rs": "pub fn visible() {} mod hidden { pub fn invisible() {} }",
		});
		expect(listPersistentState(dir).libFunctions).toEqual(["helpers::exposed::visible"]);
	});

	it("omits conditional and custom-path items instead of guessing their compiled API", () => {
		const dir = workspace({
			"helpers/mod.rs": `
#[cfg(test)] pub fn test_only() {}
#[cfg(any())] pub mod disabled { pub fn absent() {} }
#[cfg_attr(feature = "hidden", cfg(any()))] pub fn conditional() {}
#[path = "elsewhere.rs"] pub mod alternate;
pub mod inner_cfg;
#[allow(dead_code)] pub fn present() {}
`,
			"helpers/alternate.rs": "pub fn wrong_file() {}",
			"helpers/elsewhere.rs": "pub fn custom_path() {}",
			"helpers/inner_cfg.rs": "#![cfg(any())] pub fn absent() {}",
		});
		expect(listPersistentState(dir).libFunctions).toEqual(["helpers::present"]);
	});

	it("keeps state and readable APIs when modules are missing, ambiguous, or incomplete", () => {
		const dir = workspace({
			"helpers/mod.rs": "pub mod missing; pub mod ambiguous; pub mod broken; pub fn ok() {}",
			"helpers/ambiguous.rs": "pub fn flat() {}",
			"helpers/ambiguous/mod.rs": "pub fn nested() {}",
			"helpers/broken.rs": "pub fn unfinished() {",
		});
		write(dir, "state/state.json", '{"z":1,"a":2}');
		write(dir, "state/blobs/z", "z");
		write(dir, "state/blobs/a", "a");
		write(dir, "state/blobs/pending.tmp", "pending");
		expect(listPersistentState(dir)).toEqual({
			stateKeys: ["a", "z"],
			blobNames: ["a", "z"],
			libFunctions: ["helpers::ok"],
		});
	});

	it("terminates on cyclic module symlinks", () => {
		const dir = workspace({ "helpers/mod.rs": "pub mod again; pub fn ok() {}" });
		symlinkSync(".", join(dir, "agent_lib/src/helpers/again"), "dir");
		expect(listPersistentState(dir).libFunctions).toEqual(["helpers::ok"]);
	});

	it("reflects applied and reverted library edits without stale entries", () => {
		const dir = workspace({ "helpers/mod.rs": "pub fn previous() {}" });
		const applied = applyLib(dir, [{ path: "src/helpers/new.rs", content: "pub async fn added() {}" }]);
		expect(listPersistentState(dir).libFunctions).toEqual(["helpers::new::added"]);
		revertLib(applied);
		expect(listPersistentState(dir).libFunctions).toEqual(["helpers::previous"]);
	});
});
