import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "advance-beta-pointer.sh");
const OURS = '{"version":"v0.7.0-beta.200.abc1234"}';

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub `aws`. `get-object` serves `published` (or a 404), and `put-object`
 *  answers as `mode` says while logging the condition it was given. */
function stubAws(mode: string, published: string | undefined): { bin: string; log: string } {
	const base = mkdtempSync(join(tmpdir(), "beta-pointer-aws-"));
	dirs.push(base);
	const bin = join(base, "bin");
	mkdirSync(bin, { recursive: true });
	const log = join(base, "log");
	writeFileSync(join(bin, "published.json"), published ?? "");
	writeFileSync(
		join(bin, "aws"),
		`#!/bin/sh
here=$(dirname "$0")
if [ "$2" = "get-object" ]; then
  gets=$(cat "$here/gets" 2>/dev/null || echo 0)
  gets=$((gets + 1))
  echo "$gets" > "$here/gets"
  ${published === undefined ? 'echo "An error occurred (NoSuchKey) when calling the GetObject operation" >&2; exit 254' : ""}
  # The pointer moves under this run once, so the second read sees a newer one.
  for out in "$@"; do :; done
  if [ "${mode}" = "moved" ] && [ "$gets" -gt 1 ]; then
    printf '%s' '{"version":"v0.7.0-beta.999.def5678"}' > "$out"
  else
    cp "$here/published.json" "$out"
  fi
  echo '"etag-$gets"'
  exit 0
fi
echo "put $*" >> "${log}"
case "${mode}" in
  oldcli) echo "Unknown options: --if-match" >&2; exit 252 ;;
  moved) echo "An error occurred (PreconditionFailed) when calling the PutObject operation" >&2; exit 254 ;;
  denied) echo "An error occurred (AccessDenied) when calling the PutObject operation" >&2; exit 254 ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	chmodSync(join(bin, "aws"), 0o755);
	return { bin, log };
}

function localPointer(body = OURS): string {
	const dir = mkdtempSync(join(tmpdir(), "beta-pointer-local-"));
	dirs.push(dir);
	const path = join(dir, "release.json");
	writeFileSync(path, body);
	return path;
}

function run(mode: string, published: string | undefined, body = OURS, key = "beta.json", type = "application/json") {
	const { bin, log } = stubAws(mode, published);
	const args = [SCRIPT, "bucket", "https://r2.example.test", key, localPointer(body), type];
	try {
		const stdout = execFileSync("sh", args, {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, output: stdout, log };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`, log };
	}
}

/** The shape the packer writes: the version once in `version`, and again in
 *  every path under it. */
function manifest(runNumber: number): string {
	const version = `0.7.0-beta.${runNumber}.abc1234`;
	return JSON.stringify({
		version: `v${version}`,
		package: "wasmedge-agent",
		tarball: `releases/v${version}/wasmedge-agent-${version}.tgz`,
		tarballs: [{ package: "wasmedge-agent", file: `wasmedge-agent-${version}.tgz`, sha256: "aa11" }],
	});
}

function puts(log: string): string {
	try {
		return readFileSync(log, "utf-8");
	} catch {
		return "";
	}
}

describe("advance-beta-pointer.sh", () => {
	it("creates the pointer when nothing is published", () => {
		const { status, output, log } = run("ok", undefined);

		expect(status).toBe(0);
		expect(output).toContain("now names run 200");
		expect(puts(log)).toContain("--if-none-match");
	});

	it("moves the pointer forward against the ETag it read", () => {
		// The condition is what makes the read and the write one decision: a
		// run that moved the pointer in between fails this write instead of
		// losing to it.
		const { status, output, log } = run("ok", '{"version":"v0.7.0-beta.100.aaa0000"}');

		expect(status).toBe(0);
		expect(output).toContain("now names run 200");
		expect(puts(log)).toContain("--if-match");
	});

	it("leaves a pointer that already names a newer run", () => {
		// The race the freshness check cannot close: main advanced, a newer
		// build published, and this one must not take the channel back.
		const { status, output, log } = run("ok", '{"version":"v0.7.0-beta.300.ccc2222"}');

		expect(status).toBe(0);
		expect(output).toContain("already names run 300");
		expect(puts(log)).toBe("");
	});

	it("leaves a pointer that names this very run", () => {
		const { status, output } = run("ok", OURS);

		expect(status).toBe(0);
		expect(output).toContain("already names run 200");
	});

	it("decides again when the pointer moves under it", () => {
		// The condition failed, so the answer this run had is stale. It reads
		// what is there now, which is newer, and stands down.
		const { status, output } = run("moved", '{"version":"v0.7.0-beta.100.aaa0000"}');

		expect(status).toBe(0);
		expect(output).toContain("already names run 999");
	});

	it("refuses a published pointer it cannot order", () => {
		const { status, output } = run("ok", '{"version":"v0.7.0"}');

		expect(status).not.toBe(0);
		expect(output).toContain("does not name a single beta version");
	});

	it("refuses a local file it cannot order", () => {
		const { status, output } = run("ok", '{"version":"v0.7.0-beta.100.aaa0000"}', '{"version":"v0.7.0"}');

		expect(status).not.toBe(0);
		expect(output).toContain("refusing to move");
	});

	it("refuses a CLI that cannot make a conditional write", () => {
		const { status, output } = run("oldcli", '{"version":"v0.7.0-beta.100.aaa0000"}');

		expect(status).not.toBe(0);
		expect(output).toContain("does not support");
	});

	it("refuses a failure that says nothing about the pointer", () => {
		const { status, output } = run("denied", '{"version":"v0.7.0-beta.100.aaa0000"}');

		expect(status).not.toBe(0);
		expect(output).toContain("Could not move");
	});

	it("orders a full manifest by its version, and not by the paths that repeat it", () => {
		// `version`, `tarball` and every file under `tarballs` end in the same
		// string, so a match over the whole file is right here by accident.
		const { status, output } = run("ok", manifest(100), manifest(200));

		expect(status).toBe(0);
		expect(output).toContain("now names run 200");
	});

	it("refuses a manifest whose version is not the beta its paths still name", () => {
		// A stable manifest keeps the paths of the beta it was cut from. Read
		// loosely it orders as that beta, and the pointer then moves under a run
		// number that no version in the file claims.
		const stable = JSON.stringify({
			version: "v0.7.0",
			tarball: "releases/v0.7.0-beta.999.dead000/wasmedge-agent-0.7.0-beta.999.dead000.tgz",
		});
		const { status, output, log } = run("ok", manifest(100), stable);

		expect(status).not.toBe(0);
		expect(output).toContain("refusing to move");
		expect(puts(log)).toBe("");
	});

	it("refuses a manifest that is not JSON", () => {
		// The trailing comma is the small case. The truncated download is the one
		// that matters, and a pattern match passed it: everything the match
		// needed was already in the bytes that arrived.
		const trailingComma = '{"version":"v0.7.0-beta.200.abc1234",}';
		const truncated = '{"version":"v0.7.0-beta.200.abc1234","tarballs":[{"file":"x"';

		for (const body of [trailingComma, truncated]) {
			const { status, output, log } = run("ok", manifest(100), body);

			expect(status).not.toBe(0);
			expect(output).toContain("is not JSON");
			expect(puts(log)).toBe("");
		}
	});

	it("refuses a published pointer that is not JSON", () => {
		const { status, output, log } = run("ok", '{"version":"v0.7.0-beta.100.aaa0000",}');

		expect(status).not.toBe(0);
		expect(output).toContain("is not JSON");
		expect(puts(log)).toBe("");
	});

	it("refuses a manifest whose version is not a string", () => {
		const { status, output, log } = run("ok", manifest(100), '{"version":200}');

		expect(status).not.toBe(0);
		expect(output).toContain("no top-level string version field");
		expect(puts(log)).toBe("");
	});

	it("refuses a text pointer that has more than one line", () => {
		const two = "v0.7.0-beta.200.abc1234\nv0.7.0-beta.300.ccc2222\n";
		const { status, output } = run("ok", "v0.7.0-beta.100.aaa0000\n", two, "beta", "text/plain");

		expect(status).not.toBe(0);
		expect(output).toContain("refusing to move");
	});

	it("refuses a run number that the shell cannot compare", () => {
		// `[ -ge ]` on a value past the shell integer range does not answer
		// false, it fails -- and under dash the failure reads as "not newer"
		// from inside an `if` that set -e does not see. That is an older run
		// taking a pointer it must never take, so the file is refused instead.
		const huge = '{"version":"v0.7.0-beta.99999999999999999999.abc1234"}';
		const { status, output, log } = run("ok", huge);

		expect(status).not.toBe(0);
		expect(output).toContain("does not name a single beta version");
		expect(puts(log)).toBe("");
	});

	it("moves the text pointer, which is the version and nothing else", () => {
		const { status, output, log } = run(
			"ok",
			"v0.7.0-beta.100.aaa0000\n",
			"v0.7.0-beta.200.abc1234\n",
			"beta",
			"text/plain",
		);

		expect(status).toBe(0);
		expect(output).toContain("now names run 200");
		expect(puts(log)).toContain("--if-match");
	});

	it("refuses a text pointer that carries anything besides the version", () => {
		const prose = "see releases/v0.7.0-beta.200.abc1234/SHA256SUMS\n";
		const { status, output } = run("ok", "v0.7.0-beta.100.aaa0000\n", prose, "beta", "text/plain");

		expect(status).not.toBe(0);
		expect(output).toContain("refusing to move");
	});
});
