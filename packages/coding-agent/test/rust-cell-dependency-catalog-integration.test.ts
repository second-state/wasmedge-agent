import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURATED_DEPENDENCIES, curatedDependency } from "../src/core/rust-cell/dependency-catalog.js";
import { RustCellProvisioner } from "../src/core/rust-cell/index.js";
import { isTemplateWarm, resolveToolchain } from "../src/core/rust-cell/toolchain.js";

// Each catalog addition needs a representative API exercised under the actual
// WasmEdge runner and its import policy, not just a successful Cargo build.
const examples: Record<keyof typeof CURATED_DEPENDENCIES, string> = {
	"aho-corasick": 'assert!(extra::aho_corasick::AhoCorasick::new(["hello"])?.is_match("hello"));',
	arrayvec: "let v = extra::arrayvec::ArrayVec::<u8, 4>::from([1, 2, 3, 4]); assert_eq!(v.len(), 4);",
	base64:
		'use extra::base64::Engine; assert_eq!(extra::base64::engine::general_purpose::STANDARD.encode(b"ok"), "b2s=");',
	byteorder: "use extra::byteorder::ByteOrder; assert_eq!(extra::byteorder::BigEndian::read_u16(&[1, 2]), 258);",
	bytes: 'assert_eq!(extra::bytes::Bytes::from_static(b"ok").len(), 2);',
	csv: String.raw`let mut reader = extra::csv::Reader::from_reader(b"name,value\na,1\n".as_slice()); assert_eq!(reader.records().next().unwrap()?.get(0), Some("a"));`,
	"csv-core": `let mut reader = extra::csv_core::Reader::new(); let (result, _, written) = reader.read_field(b"abc,", &mut [0; 8]); assert_eq!(result, extra::csv_core::ReadFieldResult::Field { record_end: false }); assert_eq!(written, 3);`,
	"data-encoding": 'assert_eq!(extra::data_encoding::HEXLOWER.encode(b"ok"), "6f6b");',
	either: "assert_eq!(extra::either::Either::<i32, i32>::Left(7).left(), Some(7));",
	glob: 'assert!(extra::glob::Pattern::new("*.rs")?.matches("main.rs"));',
	hex: 'assert_eq!(extra::hex::encode(b"ok"), "6f6b");',
	humantime: 'assert_eq!(extra::humantime::parse_duration("2s")?.as_secs(), 2);',
	indexmap:
		'let mut map = extra::indexmap::IndexMap::new(); map.insert("a", 1); map.insert("b", 2); assert_eq!(map.get_index(0), Some((&"a", &1)));',
	itertools:
		"use extra::itertools::Itertools; assert_eq!([3, 1, 2].into_iter().sorted().collect::<Vec<_>>(), vec![1, 2, 3]);",
	itoa: 'assert_eq!(extra::itoa::Buffer::new().format(42), "42");',
	memchr: "assert_eq!(extra::memchr::memchr(b'x', b\"axb\"), Some(1));",
	once_cell: "let value = extra::once_cell::unsync::OnceCell::new(); assert_eq!(*value.get_or_init(|| 7), 7);",
	"ordered-float": "assert!(extra::ordered_float::OrderedFloat(1.0) < extra::ordered_float::OrderedFloat(2.0));",
	"percent-encoding":
		'assert_eq!(extra::percent_encoding::utf8_percent_encode("a b", extra::percent_encoding::NON_ALPHANUMERIC).to_string(), "a%20b");',
	"regex-automata": 'assert!(extra::regex_automata::meta::Regex::new("[0-9]+")?.is_match("42"));',
	"regex-syntax": 'assert!(extra::regex_syntax::Parser::new().parse("[0-9]+").is_ok());',
	semver: 'assert!(extra::semver::VersionReq::parse("^1.0")?.matches(&extra::semver::Version::parse("1.2.3")?));',
	sha2: 'use extra::sha2::Digest; assert_eq!(extra::hex::encode(extra::sha2::Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");',
	smallvec: "let mut v = extra::smallvec::SmallVec::<[u8; 2]>::new(); v.push(7); assert_eq!(v.as_slice(), &[7]);",
	strsim: 'assert_eq!(extra::strsim::levenshtein("kitten", "sitting"), 3);',
	"unicode-ident":
		"assert!(extra::unicode_ident::is_xid_start('a')); assert!(!extra::unicode_ident::is_xid_start('1'));",
	"unicode-normalization": String.raw`use extra::unicode_normalization::UnicodeNormalization; assert_eq!("e\u{301}".nfc().collect::<String>(), "é");`,
	"unicode-segmentation": String.raw`use extra::unicode_segmentation::UnicodeSegmentation; assert_eq!("e\u{301}".graphemes(true).count(), 1);`,
	"unicode-width": 'use extra::unicode_width::UnicodeWidthStr; assert_eq!("中文".width(), 4);',
	urlencoding: 'assert_eq!(extra::urlencoding::encode("a b"), "a%20b");',
};

let available = false;
try {
	resolveToolchain();
	available = isTemplateWarm();
} catch {}

describe.skipIf(!available)("curated catalog on WASI", () => {
	it("builds and executes an example for every pinned crate", { timeout: 600_000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "catalog-wasi-"));
		const names = Object.keys(CURATED_DEPENDENCIES);
		expect(Object.keys(examples).sort()).toEqual([...names].sort());
		// Validate the entire catalog in one build, rather than serializing 30
		// dependency additions inside a single cell's execution budget.
		const provisioner = new RustCellProvisioner({
			cwd: root,
			workspaceDir: join(root, "workspace"),
			preludeExtra: names.map(curatedDependency),
			cellTimeoutMs: 300_000,
		});
		try {
			const runner = await provisioner.ensure();
			const result = await runner.execute({
				code: `use agent_lib::prelude::*; fn main() -> Result<()> {
                    ${Object.values(examples)
								.map((code) => `{ ${code} }`)
								.join("\n")}
                    println!("catalog passed"); Ok(())
                }`,
			});
			expect(result.status, result.compileDiagnostics ?? result.stderr).toBe("ok");
			expect(result.stdout.trim()).toBe("catalog passed");
		} finally {
			await provisioner.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
