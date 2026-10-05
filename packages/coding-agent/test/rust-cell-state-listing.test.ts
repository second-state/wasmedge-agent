import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

	it.each(["[]", '["value"]', '"text"', "null", "42", "true", "{broken"])(
		"reports unavailable keys for invalid state %s without losing other inventory",
		(source) => {
			const dir = workspace({ "lib.rs": "pub struct Saved;" });
			write(dir, "state/state.json", source);
			write(dir, "state/blobs/result.bin", "saved blob");
			const listing = listPersistentState(dir);
			expect(listing).toMatchObject({ stateKeys: [], blobNames: ["result.bin"], libTypes: ["Saved"] });
			expect(listing.warnings).toEqual([expect.stringContaining("state keys are unavailable")]);
			expect(readFileSync(join(dir, "state/state.json"), "utf-8")).toBe(source);
		},
	);

	it("treats missing stores and an empty state object as empty without warnings", () => {
		const dir = workspace();
		expect(listPersistentState(dir).warnings).toBeUndefined();
		write(dir, "state/state.json", "{}");
		expect(listPersistentState(dir)).toMatchObject({ stateKeys: [], blobNames: [] });
		expect(listPersistentState(dir).warnings).toBeUndefined();
	});

	it("keeps state and library inventory when the blob store is not a directory", () => {
		const dir = workspace({ "lib.rs": "pub fn saved() {}" });
		write(dir, "state/state.json", '{"progress":1}');
		write(dir, "state/blobs", "not a directory");
		expect(listPersistentState(dir)).toMatchObject({
			stateKeys: ["progress"],
			blobNames: [],
			libFunctions: ["saved"],
			warnings: [expect.stringContaining("blob names are unavailable")],
		});
		expect(readFileSync(join(dir, "state/blobs"), "utf-8")).toBe("not a directory");
	});

	it("keeps blob and library inventory when the state file cannot be read", () => {
		const dir = workspace({ "lib.rs": "pub fn saved() {}" });
		mkdirSync(join(dir, "state/state.json"), { recursive: true });
		write(dir, "state/blobs/result.bin", "saved blob");
		expect(listPersistentState(dir)).toMatchObject({
			stateKeys: [],
			blobNames: ["result.bin"],
			libFunctions: ["saved"],
			warnings: [expect.stringContaining("state keys are unavailable")],
		});
	});

	it("lists regular blob files like the guest, excluding directories, symlinks and temporary files", () => {
		const dir = workspace();
		write(dir, "state/blobs/z.bin", "z");
		write(dir, "state/blobs/a.bin", "a");
		write(dir, "state/blobs/pending.tmp", "pending");
		write(dir, "state/blobs/nested/file", "nested");
		symlinkSync("a.bin", join(dir, "state/blobs/link.bin"));
		symlinkSync("missing", join(dir, "state/blobs/dangling.bin"));
		expect(listPersistentState(dir).blobNames).toEqual(["a.bin", "z.bin"]);
	});

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
			libTypes: [],
		});
	});

	it("lists public type declarations through file and inline modules", () => {
		const dir = workspace({
			"lib.rs": "pub mod helpers; pub struct Root;",
			"helpers/mod.rs": "pub mod types; pub mod nested { pub mod child; pub enum State { Ready } }",
			"helpers/types.rs": `
pub struct Record<T> { pub value: T }
pub struct Pair(pub u32, pub u32);
pub struct Unit;
pub enum Choice<T> { Some(T), None }
pub union Bits { pub int: u32, pub float: f32 }
pub type Rows<T> = Vec<Vec<T>>;
pub trait Reader<'a> { type Output; fn read(&self) -> Self::Output; }
pub unsafe trait Trusted {}
pub /* comment */ struct r#type;
pub type 中文 = u32;
pub fn make() -> Unit { Unit }
`,
			"helpers/nested/child.rs": "pub type Id = u64;",
		});
		expect(listPersistentState(dir)).toMatchObject({
			libTypes: [
				"Root",
				"helpers::nested::State",
				"helpers::nested::child::Id",
				"helpers::types::Bits",
				"helpers::types::Choice",
				"helpers::types::Pair",
				"helpers::types::Reader",
				"helpers::types::Record",
				"helpers::types::Rows",
				"helpers::types::Trusted",
				"helpers::types::Unit",
				"helpers::types::r#type",
				"helpers::types::中文",
			],
			libFunctions: ["helpers::types::make"],
		});
	});

	it("omits private, restricted, conditional, re-exported, and generated types", () => {
		const dir = workspace({
			"helpers/mod.rs": `
struct Private;
pub(crate) struct CrateOnly;
pub(super) type ParentOnly = u32;
pub(in crate::helpers) trait Restricted {}
mod hidden { pub struct Hidden; }
pub use hidden::Hidden as Reexported;
#[cfg(test)] pub struct TestOnly;
#[cfg_attr(feature = "hidden", cfg(any()))] pub enum Conditional {}
#[path = "types.rs"] pub mod custom;
pub mod inner_cfg;
pub mod broken;
macro_rules! declare { () => { pub struct Generated; }; }
declare! { pub enum Input {} }
pub fn outer() { pub struct Local; }
pub trait Visible { type Associated; fn method(); }
impl Visible for Private { type Associated = u32; fn method() {} }
// pub struct LineComment;
/* pub enum BlockComment {} */
pub const TEXT: &str = "pub struct Literal;";
#[doc = "pub type Doc = u32;"]
pub struct Actual;
`,
			"helpers/inner_cfg.rs": "#![cfg(any())] pub struct Disabled;",
			"helpers/types.rs": "pub struct CustomPath;",
			"helpers/broken.rs": "pub struct Incomplete {",
			"helpers/orphan.rs": "pub struct Undeclared;",
		});
		expect(listPersistentState(dir)).toMatchObject({
			libTypes: ["helpers::Actual", "helpers::Visible"],
			libFunctions: ["helpers::outer"],
		});
	});

	it("reflects applied and reverted type edits without stale entries", () => {
		const dir = workspace({ "helpers/mod.rs": "pub struct Previous;" });
		const applied = applyLib(dir, [{ path: "src/helpers/new.rs", content: "pub enum Added { Ready }" }]);
		expect(listPersistentState(dir).libTypes).toEqual(["helpers::new::Added"]);
		revertLib(applied);
		expect(listPersistentState(dir).libTypes).toEqual(["helpers::Previous"]);
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
