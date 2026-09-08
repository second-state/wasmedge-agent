import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "publish-github-release-assets.sh");
const TARBALL = "wasmedge-agent-0.7.0.tgz";
const TARBALL_BYTES = "tarball bytes";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub `gh`. One `api` request lists the release, one `release download`
 *  per asset already there, and one `release upload` per asset that is not. */
function stubGh(mode: string, assets: string, downloadBytes: string): { bin: string; log: string } {
	const base = mkdtempSync(join(tmpdir(), "publish-gh-"));
	dirs.push(base);
	const bin = join(base, "bin");
	mkdirSync(bin, { recursive: true });
	const log = join(base, "log");
	// The variable data lives in files the stub reads rather than in its
	// source: interpolating it makes the stub's own quoting depend on the
	// bytes under test.
	writeFileSync(join(bin, "assets.txt"), assets ? `${assets}\n` : "");
	writeFileSync(join(bin, "bytes.bin"), downloadBytes);
	writeFileSync(
		join(bin, "gh"),
		`#!/bin/sh
here=$(dirname "$0")
if [ "$1" = "api" ]; then
  case "${mode}" in
    denied) echo "gh: Bad credentials (HTTP 401)" >&2; exit 1 ;;
    norelease) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  esac
  cat "$here/assets.txt"
  exit 0
fi
if [ "$2" = "download" ]; then
  case "${mode}" in
    undownloadable) echo "gh: Server Error (HTTP 502)" >&2; exit 1 ;;
  esac
  dir=""
  name=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--dir" ]; then dir="$2"; fi
    if [ "$1" = "--pattern" ]; then name="$2"; fi
    shift
  done
  test -n "$dir" && test -n "$name" || exit 9
  # Only the tarball carries the bytes under test; the checksum file is
  # published as this build wrote it, so a test about one file is about one
  # file.
  if [ "$name" = "SHA256SUMS" ]; then
    printf '%s' "abc123  ${TARBALL}
" > "$dir/$name"
  else
    cp "$here/bytes.bin" "$dir/$name"
  fi
  exit 0
fi
if [ "$2" = "upload" ]; then
  case "${mode}" in
    unuploadable) echo "gh: release asset already exists (HTTP 422)" >&2; exit 1 ;;
  esac
  echo "upload $4" >> "${log}"
  exit 0
fi
exit 9
`,
		{ mode: 0o755 },
	);
	chmodSync(join(bin, "gh"), 0o755);
	return { bin, log };
}

/** The two files a release this size publishes. */
function localRelease(): string {
	const dir = mkdtempSync(join(tmpdir(), "publish-gh-local-"));
	dirs.push(dir);
	writeFileSync(join(dir, TARBALL), TARBALL_BYTES);
	writeFileSync(join(dir, "SHA256SUMS"), `abc123  ${TARBALL}\n`);
	return dir;
}

function run(mode: string, assets: string, downloadBytes = TARBALL_BYTES) {
	const { bin, log } = stubGh(mode, assets, downloadBytes);
	try {
		const stdout = execFileSync("sh", [SCRIPT, "acme/wasmedge-agent", "v0.7.0", localRelease()], {
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

function uploads(log: string): string {
	try {
		return readFileSync(log, "utf-8");
	} catch {
		return "";
	}
}

describe("publish-github-release-assets.sh", () => {
	it("uploads the assets a release does not have yet", () => {
		const { status, log } = run("ok", "");

		expect(status).toBe(0);
		expect(uploads(log)).toContain(TARBALL);
		expect(uploads(log)).toContain("SHA256SUMS");
	});

	it("keeps an asset whose published bytes match this build", () => {
		// A re-run of a release that is already complete must not pass through
		// a state where it is missing a file it had.
		const { status, output, log } = run("ok", `${TARBALL}\nSHA256SUMS`, TARBALL_BYTES);

		expect(status).toBe(0);
		expect(output).toContain("Keeping");
		expect(uploads(log)).not.toContain(TARBALL);
	});

	it("refuses an asset published with different bytes", () => {
		// The reason this compares rather than trusting an earlier guard: the
		// asset can arrive in the window between that guard and this upload,
		// and a name is all the loop that trusted it ever saw.
		const { status, output } = run("ok", TARBALL, "someone else's bytes");

		expect(status).not.toBe(0);
		expect(output).toContain("different bytes");
	});

	it("refuses when a published asset cannot be read", () => {
		const { status, output } = run("undownloadable", TARBALL);

		expect(status).not.toBe(0);
		expect(output).toContain("could not be downloaded");
	});

	it("refuses when the release cannot be listed", () => {
		// Fails closed: an answer it could not read is not one that says the
		// release is empty.
		const { status, output } = run("denied", "");

		expect(status).not.toBe(0);
		expect(output).toContain("refusing to publish into it");
	});

	it("refuses when an asset appears after the listing", () => {
		// No --clobber, so an asset added in the window fails the upload
		// rather than being replaced by bytes nothing compared.
		const { status, output } = run("unuploadable", "");

		expect(status).not.toBe(0);
		expect(output).toContain("already exists");
	});
});
