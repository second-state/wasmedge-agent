import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "publish-immutable-object.sh");
const KEY = "releases/v0.7.0/wasmedge-agent-0.7.0.tgz";
const BYTES = "tarball bytes";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub `aws`. `s3api put-object` answers as `mode` says, and `s3 cp` serves
 *  whatever bytes the published copy is meant to have. */
function stubAws(mode: string, publishedBytes: string): { bin: string; log: string } {
	const base = mkdtempSync(join(tmpdir(), "immutable-aws-"));
	dirs.push(base);
	const bin = join(base, "bin");
	mkdirSync(bin, { recursive: true });
	const log = join(base, "log");
	writeFileSync(join(bin, "published.bin"), publishedBytes);
	writeFileSync(
		join(bin, "aws"),
		`#!/bin/sh
here=$(dirname "$0")
if [ "$1" = "s3api" ]; then
  # The condition is the whole point: a run that drops it must not pass.
  echo "put $*" >> "${log}"
  case "$*" in
    *--if-none-match*) ;;
    *) echo "stub: put-object without --if-none-match" >&2; exit 90 ;;
  esac
  attempts=$(cat "$here/attempts" 2>/dev/null || echo 0)
  attempts=$((attempts + 1))
  echo "$attempts" > "$here/attempts"
  case "${mode}" in
    conflictthenfree)
      if [ "$attempts" -lt 3 ]; then
        echo "An error occurred (ConditionalRequestConflict) when calling the PutObject operation: Another conditional request for this object is in progress" >&2
        exit 254
      fi ;;
    conflict)
      echo "An error occurred (ConditionalRequestConflict) when calling the PutObject operation: Another conditional request for this object is in progress" >&2
      exit 254 ;;
  esac
  case "${mode}" in
    exists|unreadable)
      echo "An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold" >&2
      exit 254 ;;
    oldcli)
      echo "Unknown options: --if-none-match" >&2
      exit 252 ;;
    denied)
      echo "An error occurred (AccessDenied) when calling the PutObject operation" >&2
      exit 254 ;;
  esac
  exit 0
fi
# aws s3 cp s3://... <dest> --endpoint-url ...
case "${mode}" in
  unreadable) echo "An error occurred (AccessDenied) when calling the GetObject operation" >&2; exit 255 ;;
esac
cp "$here/published.bin" "$4"
exit 0
`,
		{ mode: 0o755 },
	);
	chmodSync(join(bin, "aws"), 0o755);
	return { bin, log };
}

function localFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "immutable-local-"));
	dirs.push(dir);
	const path = join(dir, "artifact.tgz");
	writeFileSync(path, BYTES);
	return path;
}

function run(mode: string, publishedBytes = BYTES) {
	const { bin, log } = stubAws(mode, publishedBytes);
	const args = [SCRIPT, "bucket", "https://r2.example.test", KEY, localFile(), "application/gzip"];
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

describe("publish-immutable-object.sh", () => {
	it("creates an object whose key is free", () => {
		const { status, output, log } = run("free");

		expect(status).toBe(0);
		expect(output).toContain("Published");
		expect(readFileSync(log, "utf-8")).toContain("--if-none-match");
	});

	it("accepts a retry that would write the same bytes", () => {
		// The publish that has to survive: a run interrupted after some objects
		// went up is re-run, and two clean packs of one commit are identical.
		const { status, output } = run("exists", BYTES);

		expect(status).toBe(0);
		expect(output).toContain("already holds these exact bytes");
	});

	it("refuses when the key already holds different bytes", () => {
		// The race this exists for: another publisher got there first, and an
		// unconditional copy would have replaced bytes caches already hold.
		const { status, output } = run("exists", "someone else's release");

		expect(status).not.toBe(0);
		expect(output).toContain("already published with different bytes");
	});

	it("refuses when the existing object cannot be read", () => {
		const { status, output } = run("unreadable", BYTES);

		expect(status).not.toBe(0);
		expect(output).toContain("could not be read");
	});

	it("refuses a CLI that cannot make a conditional write", () => {
		// Falling back to an unconditional put would publish exactly the way
		// this exists to stop, and would do it without saying so.
		const { status, output } = run("oldcli");

		expect(status).not.toBe(0);
		expect(output).toContain("does not support --if-none-match");
	});

	it("retries a conditional-request conflict", () => {
		// 409 says another conditional request for this key was in flight and
		// this one was not evaluated. It is not an answer about what is
		// published, so it is retried rather than read as either outcome.
		const { status, output, log } = run("conflictthenfree");

		expect(status).toBe(0);
		expect(output).toContain("Published");
		expect(readFileSync(log, "utf-8").split("\n").filter(Boolean).length).toBe(3);
	});

	it("gives up on a conflict that does not clear", () => {
		const { status, output } = run("conflict");

		expect(status).not.toBe(0);
		expect(output).toContain("conditional-request conflict after");
	});

	it("refuses a failure that says nothing about what is published", () => {
		const { status, output } = run("denied");

		expect(status).not.toBe(0);
		expect(output).toContain("Could not publish");
	});
});
