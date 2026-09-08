import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const GUARD = join(__dirname, "..", "..", "..", "scripts", "guard-immutable-release.sh");
const PREFIX = "releases/v0.7.0";
const TARBALL = "wasmedge-agent-0.7.0.tgz";
const SUMS = "abc123  wasmedge-agent-0.7.0.tgz\n";
const MANIFEST = '{"version":"v0.7.0"}';

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub `aws` on PATH, so the guard's five outcomes are reachable without a
 *  bucket. The real client reports every one of them the same way -- a nonzero
 *  exit and a line on stderr -- which is exactly why the guard may not read an
 *  exit status as an answer. */
function stubAws(mode: string, listing: string): string {
	const base = mkdtempSync(join(tmpdir(), "guard-release-"));
	dirs.push(base);
	const bin = join(base, "bin");
	mkdirSync(bin, { recursive: true });
	const aws = join(bin, "aws");
	writeFileSync(
		aws,
		`#!/bin/sh
if [ "$1" = "s3api" ]; then
  case "${mode}" in
    denied) echo "An error occurred (AccessDenied) when calling the ListObjectsV2 operation" >&2; exit 255 ;;
    network) echo "Could not connect to the endpoint URL" >&2; exit 255 ;;
  esac
  printf '%s\\n' '${listing}'
  exit 0
fi
# aws s3 cp <src> <dest> --endpoint-url ...
case "${mode}" in
  unreadable) echo "An error occurred (AccessDenied) when calling the GetObject operation" >&2; exit 255 ;;
esac
case "$3" in
  *"/SHA256SUMS")
    case "${mode}" in
      different) printf '%s' 'deadbeef  ${TARBALL}
' > "$4" ;;
      *) printf '%s' '${SUMS}' > "$4" ;;
    esac ;;
  *"/release.json")
    printf '%s' '${MANIFEST}' > "$4" ;;
  *)
    case "${mode}" in
      differentTarball) printf '%s' 'not the tarball' > "$4" ;;
      *) printf '%s' 'tarball' > "$4" ;;
    esac ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	chmodSync(aws, 0o755);
	return bin;
}

function localRelease(): string {
	const dir = mkdtempSync(join(tmpdir(), "guard-release-local-"));
	dirs.push(dir);
	writeFileSync(join(dir, TARBALL), "tarball");
	writeFileSync(join(dir, "SHA256SUMS"), SUMS);
	// The release manifest goes up under the prefix too: an install that names
	// a version resolves no channel, so this is what tells it which package
	// each of these files contains.
	writeFileSync(join(dir, "release.json"), MANIFEST);
	return dir;
}

function runGuard(mode: string, listing: string): { status: number; output: string } {
	const bin = stubAws(mode, listing);
	try {
		const stdout = execFileSync("sh", [GUARD, "bucket", "https://r2.example.test", PREFIX, localRelease()], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, output: stdout };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
	}
}

const BOTH_KEYS = `${PREFIX}/${TARBALL}\t${PREFIX}/SHA256SUMS\t${PREFIX}/release.json`;

describe("guard-immutable-release.sh", () => {
	it("publishes when the version has never been published", () => {
		// The one listing that is evidence: it succeeded, and it is empty.
		// awscli spells an empty result "None" rather than nothing at all.
		const { status, output } = runGuard("absent", "None");

		expect(status).toBe(0);
		expect(output).toContain("is empty; publishing");
	});

	it("refuses when the listing is denied", () => {
		const { status, output } = runGuard("denied", "");

		expect(status).toBe(1);
		expect(output).toContain("refusing to publish");
		expect(output).toContain("AccessDenied");
	});

	it("refuses when the listing cannot reach the endpoint", () => {
		// The failure this guard was written against: the probe it replaced
		// read any nonzero exit as "nothing is published there", so one bad
		// minute of network was enough to license an overwrite.
		const { status, output } = runGuard("network", "");

		expect(status).toBe(1);
		expect(output).toContain("refusing to publish");
		expect(output).toContain("Could not connect");
	});

	it("completes a prefix left half-published by an earlier run", () => {
		// Tarballs up, checksums not yet -- an interruption between the two
		// upload loops, and the likeliest reason anyone re-runs at all.
		// Refusing it would cost the version permanently for one bad minute
		// of network.
		const { status, output } = runGuard("partial", `${PREFIX}/${TARBALL}`);

		expect(status).toBe(0);
		expect(output).toContain("partial publish of these exact bytes");
	});

	it("refuses a half-published prefix whose bytes are another build's", () => {
		// The same shape, and the one the completion must not swallow. There
		// is no published SHA256SUMS to compare here -- it is the object that
		// did not make it -- so the tarball itself has to be read.
		const { status, output } = runGuard("differentTarball", `${PREFIX}/${TARBALL}`);

		expect(status).toBe(1);
		expect(output).toContain("already published with different bytes");
	});

	it("refuses a prefix holding an object this release does not produce", () => {
		const { status, output } = runGuard("absent", `${PREFIX}/${TARBALL}\t${PREFIX}/wasmedge-agent-9.9.9.tgz`);

		expect(status).toBe(1);
		expect(output).toContain("objects this release does not produce");
	});

	it("refuses when the published checksums differ", () => {
		const { status, output } = runGuard("different", BOTH_KEYS);

		expect(status).toBe(1);
		expect(output).toContain("already published with different bytes");
	});

	it("refuses when the published checksums cannot be read", () => {
		const { status, output } = runGuard("unreadable", BOTH_KEYS);

		expect(status).toBe(1);
		expect(output).toContain("could not be read");
	});

	it("allows a retry that produces the same bytes", () => {
		// A publish step that failed partway is re-run, and the packer rebuilds
		// from source before every pack, so the retry hashes identically. This
		// case is why the guard compares bytes instead of refusing outright.
		const { status, output } = runGuard("same", BOTH_KEYS);

		expect(status).toBe(0);
		expect(output).toContain("republishing is a no-op");
	});
});
