import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "..", "..", "scripts", "advance-channel-pointer.sh");
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

function run(
	mode: string,
	published: string | undefined,
	body = OURS,
	key = "beta.json",
	type = "application/json",
	ordering = "beta-run",
) {
	const { bin, log } = stubAws(mode, published);
	const args = [SCRIPT, "bucket", "https://r2.example.test", key, localPointer(body), type, ordering];
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

describe("advance-channel-pointer.sh", () => {
	it("creates the pointer when nothing is published", () => {
		const { status, output, log } = run("ok", undefined);

		expect(status).toBe(0);
		expect(output).toContain("now names v0.7.0-beta.200.abc1234");
		expect(puts(log)).toContain("--if-none-match");
	});

	it("moves the pointer forward against the ETag it read", () => {
		// The condition is what makes the read and the write one decision: a
		// run that moved the pointer in between fails this write instead of
		// losing to it.
		const { status, output, log } = run("ok", '{"version":"v0.7.0-beta.100.aaa0000"}');

		expect(status).toBe(0);
		expect(output).toContain("now names v0.7.0-beta.200.abc1234");
		expect(puts(log)).toContain("--if-match");
	});

	it("leaves a pointer that already names a newer run", () => {
		// The race the freshness check cannot close: main advanced, a newer
		// build published, and this one must not take the channel back.
		const { status, output, log } = run("ok", '{"version":"v0.7.0-beta.300.ccc2222"}');

		expect(status).toBe(3);
		expect(output).toContain("already names v0.7.0-beta.300.ccc2222");
		expect(puts(log)).toBe("");
	});

	it("carries on when the pointer already names this very build", () => {
		// A publication that stopped after this object is finished by re-running
		// it, and a run that cannot get past its own pointer can never repair
		// what came after it. Nothing to move here is not the same as losing.
		const { status, output, log } = run("ok", OURS);

		expect(status).toBe(0);
		expect(output).toContain("already names v0.7.0-beta.200.abc1234, which is this build");
		expect(puts(log)).toBe("");
	});

	it("decides again when the pointer moves under it", () => {
		// The condition failed, so the answer this run had is stale. It reads
		// what is there now, which is newer, and stands down.
		const { status, output } = run("moved", '{"version":"v0.7.0-beta.100.aaa0000"}');

		expect(status).toBe(3);
		expect(output).toContain("already names v0.7.0-beta.999.def5678");
	});

	it("refuses a published pointer it cannot order", () => {
		const { status, output } = run("ok", '{"version":"v0.7.0"}');

		expect(status).not.toBe(0);
		expect(output).toContain("does not name one beta-run version");
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
		expect(output).toContain("now names v0.7.0-beta.200.abc1234");
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
		expect(output).toContain("does not name one beta-run version");
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
		expect(output).toContain("now names v0.7.0-beta.200.abc1234");
		expect(puts(log)).toContain("--if-match");
	});

	it("refuses a text pointer that carries anything besides the version", () => {
		const prose = "see releases/v0.7.0-beta.200.abc1234/SHA256SUMS\n";
		const { status, output } = run("ok", "v0.7.0-beta.100.aaa0000\n", prose, "beta", "text/plain");

		expect(status).not.toBe(0);
		expect(output).toContain("refusing to move");
	});
	const release = (published: string | undefined, body: string, key = "latest.json", type = "application/json") =>
		run("ok", published, body, key, type, "release");

	it("refuses to take the stable channel back to an older release", () => {
		// Finishing a partial v0.7.0 after v0.8.0 shipped republished both
		// production pointers at v0.7.0, unconditionally, and every stable
		// install then resolved the older one.
		const { status, output, log } = release('{"version":"v0.8.0"}', '{"version":"v0.7.0"}');

		expect(status).toBe(3);
		expect(output).toContain("already names v0.8.0");
		expect(puts(log)).toBe("");
	});

	it("carries on when the stable channel already names this release", () => {
		// The recovery case: `stable` moved, then an installer upload or
		// latest.json failed. The retry has to reach them.
		const { status, output, log } = release('{"version":"v0.8.0"}', '{"version":"v0.8.0"}');

		expect(status).toBe(0);
		expect(output).toContain("already names v0.8.0, which is this build");
		expect(puts(log)).toBe("");
	});

	it("moves the stable channel forward to a newer release", () => {
		const { status, output, log } = release('{"version":"v0.7.0"}', '{"version":"v0.8.0"}');

		expect(status).toBe(0);
		expect(output).toContain("now names v0.8.0");
		expect(puts(log)).toContain("--if-match");
	});

	it("creates the stable pointer when nothing is published", () => {
		const { status, output, log } = release(undefined, '{"version":"v0.7.0"}');

		expect(status).toBe(0);
		expect(output).toContain("now names v0.7.0");
		expect(puts(log)).toContain("--if-none-match");
	});

	it("orders a release field by field, and not as text", () => {
		// 0.10.0 is later than 0.9.0 and sorts before it as a string, which is
		// the whole reason the comparison splits the version up.
		const forward = release('{"version":"v0.9.0"}', '{"version":"v0.10.0"}');
		const backward = release('{"version":"v0.10.0"}', '{"version":"v0.9.0"}');

		expect(forward.status).toBe(0);
		expect(forward.output).toContain("now names v0.10.0");
		expect(backward.status).toBe(3);
		expect(backward.output).toContain("already names v0.10.0");
	});

	it("moves the stable text pointer, which is the version alone", () => {
		const { status, output } = release("v0.6.9\n", "v0.7.0\n", "stable", "text/plain");

		expect(status).toBe(0);
		expect(output).toContain("now names v0.7.0");
	});

	it("refuses a prerelease on the release channel", () => {
		// A beta orders by run number, and nothing here can place one among the
		// releases: v0.8.0-beta.200 is not a version this channel names.
		const { status, output, log } = release('{"version":"v0.7.0"}', OURS);

		expect(status).not.toBe(0);
		expect(output).toContain("does not name one release version");
		expect(puts(log)).toBe("");
	});

	it("refuses an ordering it does not implement", () => {
		const { status, output } = run("ok", undefined, OURS, "beta.json", "application/json", "nightly");

		expect(status).not.toBe(0);
		expect(output).toContain("Unknown ordering");
	});
	/** A rendered installer: the release it came from, on a line of its own. */
	const installer = (version: string) => `#!/bin/sh\n# wasmedge-agent-rendered-release: ${version}\necho hi\n`;

	const script = (published: string, body: string) =>
		run("ok", published, body, "install.sh", "text/x-shellscript", "release");

	it("moves the canonical installer forward to a newer release", () => {
		const { status, output, log } = script(installer("v0.7.0"), installer("v0.8.0"));

		expect(status).toBe(0);
		expect(output).toContain("now names v0.8.0");
		expect(puts(log)).toContain("--if-match");
	});

	it("refuses to put an older installer over a newer one", () => {
		// Two runs publishing at once used to leave the pointers naming one
		// release and this script coming from another, because it went up with
		// a plain copy that nothing ordered.
		const { status, output, log } = script(installer("v0.8.0"), installer("v0.7.0"));

		expect(status).toBe(3);
		expect(output).toContain("already names v0.8.0");
		expect(puts(log)).toBe("");
	});

	it("refuses an installer that was never rendered", () => {
		const unrendered = installer("__WASMEDGE_AGENT_RENDERED" + "_RELEASE__");
		const { status, output, log } = script(installer("v0.7.0"), unrendered);

		expect(status).not.toBe(0);
		expect(output).toContain("does not name one release version");
		expect(puts(log)).toBe("");
	});
});
