import { describe, expect, it } from "vitest";
import { normalizePreludeExtra } from "../src/core/rust-cell/prelude-extra.js";

describe("preludeExtra validation", () => {
	it("normalizes a detached configuration with stable crate and feature order", () => {
		const input = [
			{ name: "memchr", version: "2.8.3", features: ["std", "alloc", "std"], defaultFeatures: false },
			{ name: "itoa", version: "1.0.18" },
		];
		expect(normalizePreludeExtra(input)).toEqual([
			{ name: "itoa", version: "1.0.18", features: [], defaultFeatures: true },
			{ name: "memchr", version: "2.8.3", features: ["alloc", "std"], defaultFeatures: false },
		]);
		expect(input[0].features).toEqual(["std", "alloc", "std"]);
		expect(normalizePreludeExtra(undefined)).toEqual([]);
	});

	it.each(
		[
			null,
			{},
			"itoa",
			[null],
			["itoa"],
			[{ name: "../itoa", version: "1.0.18" }],
			[{ name: "itoa\n[patch]", version: "1.0.18" }],
			[{ name: "itoa", version: "1" }],
			[{ name: "itoa", version: "^1.0.18" }],
			[{ name: "itoa", version: "01.0.18" }],
			[{ name: "itoa", version: "1.0.18", git: "https://example.com/repo" }],
			[{ name: "itoa", version: "1.0.18", path: "/tmp/crate" }],
			[{ name: "itoa", version: "1.0.18", defaultFeatures: "false" }],
			[{ name: "itoa", version: "1.0.18", features: "std" }],
			[{ name: "itoa", version: "1.0.18", features: ["dependency/feature"] }],
			[
				{ name: "foo-bar", version: "1.0.0" },
				{ name: "foo_bar", version: "2.0.0" },
			],
			...["rlm", "agent-lib", "cell", "serde", "std", "self", "type", "gen"].map((name) => [
				{ name, version: "1.0.0" },
			]),
		].map((value) => [value]),
	)("rejects invalid settings %j", (value) => {
		expect(() => normalizePreludeExtra(value)).toThrow("rustCell.preludeExtra");
	});
});
