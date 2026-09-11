import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "decide-release-latest.sh");

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub `gh`. `latest` is the tag the repository currently marks Latest, or
 *  undefined for a repository with no release yet, which GitHub answers with a
 *  404. `mode` "broken" is every other failure: a token that expired, a rate
 *  limit, a 5xx. */
function stubGh(latest: string | undefined, mode = "ok"): string {
	const base = mkdtempSync(join(tmpdir(), "decide-latest-gh-"));
	dirs.push(base);
	const bin = join(base, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "gh"),
		`#!/bin/sh
${mode === "broken" ? 'echo "gh: Bad gateway (HTTP 502)" >&2; exit 1' : ""}
${latest === undefined ? 'echo "gh: Not Found (HTTP 404)" >&2; exit 1' : `printf '%s\\n' "${latest}"`}
`,
		{ mode: 0o755 },
	);
	chmodSync(join(bin, "gh"), 0o755);
	return bin;
}

function run(latest: string | undefined, version: string, mode = "ok") {
	const bin = stubGh(latest, mode);
	try {
		const output = execFileSync("sh", [SCRIPT, "owner/repo", version], {
			encoding: "utf-8",
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		});
		return { status: 0, output: output.trim() };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string };
		return { status: failure.status ?? 1, output: (failure.stdout ?? "").trim() };
	}
}

describe("decide-release-latest", () => {
	it("marks the first release of a repository as latest", () => {
		expect(run(undefined, "0.0.1")).toEqual({ status: 0, output: "true" });
	});

	it("marks a newer version as latest", () => {
		expect(run("v0.8.0", "0.9.0")).toEqual({ status: 0, output: "true" });
	});

	it("compares by version and not as text", () => {
		// The whole point. As strings, "0.10.0" sorts before "0.9.0".
		expect(run("v0.9.0", "0.10.0")).toEqual({ status: 0, output: "true" });
	});

	it("leaves the channel alone when an older version is published", () => {
		// Finishing a partial v0.7.0 after v0.8.0 shipped.
		expect(run("v0.8.0", "0.7.0")).toEqual({ status: 0, output: "false" });
	});

	it("answers the same way twice for the release already marked latest", () => {
		expect(run("v0.8.0", "0.8.0")).toEqual({ status: 0, output: "true" });
	});

	it("never marks a prerelease as latest", () => {
		expect(run("v0.8.0", "0.9.0-beta.12.abc1234")).toEqual({ status: 0, output: "false" });
	});

	it("fails closed when it cannot find out", () => {
		// A 502 is not an answer about what is published, and reading it as
		// "no release yet" would hand the channel to whatever ran next.
		const result = run("v0.8.0", "0.9.0", "broken");
		expect(result.status).not.toBe(0);
		expect(result.output).toBe("");
	});
});
