import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const GUARD = join(__dirname, "..", "..", "..", "scripts", "guard-immutable-github-assets.sh");
const TARBALL = "wasmedge-agent-0.7.0.tgz";
const TARBALL_BYTES = "tarball bytes";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub `gh` on PATH. The guard makes one `api` request -- which answers both
 *  whether the release exists and what is on it -- and one `release download`
 *  per asset it is about to replace. */
function stubGh(mode: string, assets: string, downloadBytes: string): string {
	const base = mkdtempSync(join(tmpdir(), "guard-gh-"));
	dirs.push(base);
	const bin = join(base, "bin");
	mkdirSync(bin, { recursive: true });
	const gh = join(bin, "gh");
	// The variable data goes in files the stub reads, not into its source.
	// Interpolating it produced a stub whose own quoting broke on an
	// apostrophe, and a broken stub fails as "could not download" -- which
	// looks enough like a refusal to pass a test that was checking for one.
	writeFileSync(join(bin, "assets.txt"), assets ? `${assets}\n` : "");
	writeFileSync(join(bin, "bytes.bin"), downloadBytes);
	writeFileSync(
		gh,
		`#!/bin/sh
here=$(dirname "$0")
# gh api repos/<repo>/releases/tags/<tag> --jq ...
if [ "$1" = "api" ]; then
  case "${mode}" in
    norelease) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
    denied) echo "gh: Bad credentials (HTTP 401)" >&2; exit 1 ;;
    ratelimited) echo "gh: API rate limit exceeded (HTTP 403)" >&2; exit 1 ;;
    servererror) echo "gh: Server Error (HTTP 502)" >&2; exit 1 ;;
    network) echo "error connecting to api.github.com" >&2; exit 1 ;;
  esac
  cat "$here/assets.txt"
  exit 0
fi
# gh release download <tag> --repo <repo> --pattern <name> --dir <dir> --clobber
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
cp "$here/bytes.bin" "$dir/$name"
exit 0
`,
		{ mode: 0o755 },
	);
	chmodSync(gh, 0o755);
	return bin;
}

function localRelease(): string {
	const dir = mkdtempSync(join(tmpdir(), "guard-gh-local-"));
	dirs.push(dir);
	writeFileSync(join(dir, TARBALL), TARBALL_BYTES);
	writeFileSync(join(dir, "SHA256SUMS"), `abc123  ${TARBALL}\n`);
	return dir;
}

function runGuard(mode: string, assets: string, downloadBytes = TARBALL_BYTES, rolling?: string) {
	const bin = stubGh(mode, assets, downloadBytes);
	const args = [GUARD, "acme/wasmedge-agent", "v0.7.0", localRelease()];
	if (rolling !== undefined) args.push(rolling);
	try {
		const stdout = execFileSync("sh", args, {
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

describe("guard-immutable-github-assets.sh", () => {
	it("allows a release that does not exist yet", () => {
		// The one failure that is an answer: an explicit 404.
		const { status, output } = runGuard("norelease", "");

		expect(status).toBe(0);
		expect(output).toContain("will be created");
	});

	it("allows a release whose existing assets are not ours to replace", () => {
		// The rolling beta tag accumulates a tarball per beta. Assets this run
		// does not upload are not this run's business.
		const { status, output } = runGuard("ok", "wasmedge-agent-0.6.0.tgz");

		expect(status).toBe(0);
		expect(output).toContain("0 existing asset(s) match");
	});

	it("allows a retry whose existing assets are byte-identical", () => {
		const { status, output } = runGuard("ok", `${TARBALL}`);

		expect(status).toBe(0);
		expect(output).toContain("1 existing asset(s) match");
	});

	it("refuses to replace an asset with different bytes", () => {
		// The case the bucket guard cannot see: the packer stamps the
		// publication host into the public manifest, so one commit packed
		// against a new R2_PUBLIC_BASE_URL produces a different tarball. The
		// tag check passes and the new bucket's prefix is empty; only the
		// release's own assets still remember what this version was.
		const { status, output } = runGuard("ok", `${TARBALL}`, "packed against another host");

		expect(status).toBe(1);
		expect(output).toContain("different bytes");
	});

	// The probe answers two questions at once -- does the release exist, and
	// what is on it -- so every way it can fail has to be told apart from a 404
	// rather than lumped in with it. Reading any of these as absence waves the
	// caller through to `gh release upload --clobber`.
	it.each([
		["an authentication error", "denied", "HTTP 401"],
		["a rate limit", "ratelimited", "HTTP 403"],
		["a server error", "servererror", "HTTP 502"],
		["a network failure", "network", "error connecting"],
	])("refuses on %s from the probe", (_label, mode, evidence) => {
		const { status, output } = runGuard(mode, "");

		expect(status).toBe(1);
		expect(output).toContain("refusing to publish");
		expect(output).toContain(evidence);
	});

	it("leaves declared rolling assets alone", () => {
		// The beta release's SHA256SUMS, beta and beta.json keep their names and
		// change their contents every run. Guarding them would refuse every beta
		// publish; the tarball beside them still gets compared.
		const { status, output } = runGuard(
			"ok",
			"SHA256SUMS",
			"checksums from another build",
			"SHA256SUMS beta beta.json",
		);

		expect(status).toBe(0);
		expect(output).toContain("0 existing asset(s) match");
	});

	it("still compares an asset that is not declared rolling", () => {
		const { status, output } = runGuard("ok", "SHA256SUMS", "checksums from another build", "beta beta.json");

		expect(status).toBe(1);
		expect(output).toContain("different bytes");
	});

	it("refuses when an existing asset cannot be downloaded", () => {
		const { status, output } = runGuard("undownloadable", `${TARBALL}`);

		expect(status).toBe(1);
		expect(output).toContain("refusing to replace it");
	});
});
