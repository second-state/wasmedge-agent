import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const installerSource = readFileSync(join(repoRoot, "install.sh"), "utf-8");

/** The installer, up to the call that would run it.
 *
 *  The same slice scripts/check-installer-render.mjs takes: everything above
 *  `main "$@"` is definitions, so sourcing it gives a shell with the
 *  installer's functions and none of its behaviour. */
const harnessPrefix = installerSource.slice(0, installerSource.lastIndexOf('\nmain "$@"'));

/** `process.env` with the installer's own knobs removed. The installer reads
 *  its whole `WASMEDGE_AGENT_*` namespace from the environment -- the WasmEdge
 *  override, the release channel, the version, the package -- so a caller that
 *  has one of them set would otherwise be deciding these tests. What a test
 *  needs from that namespace, the test sets itself. */
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("WASMEDGE_AGENT_")));

const BASE_URL = "https://releases.example.test";
const VERSION = "9.9.9";
const ROOT_TARBALL = `wasmedge-agent-${VERSION}.tgz`;
const AI_TARBALL = `wasmedge-agent-ai-${VERSION}.tgz`;
const TUI_TARBALL = `wasmedge-agent-tui-${VERSION}.tgz`;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function packageTarball(workDir: string, file: string, manifest: Record<string, unknown>): string {
	const stage = join(workDir, "stage", file);
	mkdirSync(join(stage, "package"), { recursive: true });
	writeFileSync(join(stage, "package", "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	const tarball = join(workDir, "release", file);
	execFileSync("tar", ["-czf", tarball, "-C", stage, "package"]);
	return tarball;
}

/** A release directory holding the four files a real one publishes, minus the
 *  package this fixture does not need. The root package names its internal
 *  dependencies exactly as the packer writes them: URLs under this release. */
function stageRelease(): { workDir: string; releaseDir: string; downloadDir: string } {
	const workDir = mkdtempSync(join(tmpdir(), "installer-verify-"));
	tempDirs.push(workDir);
	const releaseDir = join(workDir, "release");
	const downloadDir = join(workDir, "download");
	mkdirSync(releaseDir, { recursive: true });
	mkdirSync(downloadDir, { recursive: true });

	packageTarball(workDir, AI_TARBALL, { name: "wasmedge-agent-ai", version: VERSION });
	packageTarball(workDir, TUI_TARBALL, { name: "wasmedge-agent-tui", version: VERSION });
	packageTarball(workDir, ROOT_TARBALL, {
		name: "wasmedge-agent",
		version: VERSION,
		dependencies: {
			"@earendil-works/pi-ai": `${BASE_URL}/releases/v${VERSION}/${AI_TARBALL}`,
			chalk: "^5.5.0",
		},
		optionalDependencies: {
			"@earendil-works/pi-tui": `${BASE_URL}/releases/v${VERSION}/${TUI_TARBALL}`,
		},
	});

	writeChecksums(releaseDir, [ROOT_TARBALL, AI_TARBALL, TUI_TARBALL]);
	return { workDir, releaseDir, downloadDir };
}

function writeChecksums(releaseDir: string, files: string[]): void {
	const lines = files.map((file) => {
		const digest = createHash("sha256")
			.update(readFileSync(join(releaseDir, file)))
			.digest("hex");
		return `${digest}  ${file}`;
	});
	writeFileSync(join(releaseDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

/** curl, as far as this installer uses it: `-fsSL <url> -o <path>`. Serves
 *  the release directory by file name, so a URL the installer did not expect
 *  to fetch is a file that is not there. */
function stubCurl(workDir: string, releaseDir: string): string {
	const bin = join(workDir, "bin");
	mkdirSync(bin, { recursive: true });
	const curl = join(bin, "curl");
	writeFileSync(
		curl,
		`#!/bin/sh
url=
out=
while [ $# -gt 0 ]; do
	case "$1" in
		-o) out="$2"; shift 2 ;;
		-*) shift ;;
		*) url="$1"; shift ;;
	esac
done
name=\${url##*/}
[ -f "${releaseDir}/$name" ] || exit 22
cp "${releaseDir}/$name" "$out"
`,
	);
	chmodSync(curl, 0o755);
	return bin;
}

function runStaging(workDir: string, releaseDir: string, downloadDir: string) {
	const downloadedRoot = join(downloadDir, ROOT_TARBALL);
	writeFileSync(downloadedRoot, readFileSync(join(releaseDir, ROOT_TARBALL)));
	writeFileSync(join(downloadDir, "SHA256SUMS"), readFileSync(join(releaseDir, "SHA256SUMS")));

	const resultPath = join(workDir, "result");
	const harness = join(workDir, "harness.sh");
	writeFileSync(
		harness,
		`${harnessPrefix}

# The real one drives a terminal; the command it wraps is all this needs.
wasmedge_agent_run_quiet_with_animation() {
	shift 3
	"$@"
}

stage_verified_wasmedge_agent_package "${VERSION}" "${downloadedRoot}" "${join(downloadDir, "SHA256SUMS")}"
printf '%s\\n' "$wasmedge_agent_install_tarball" > "${resultPath}"
`,
	);

	try {
		execFileSync("sh", [harness], {
			env: {
				...hostEnv,
				PATH: `${stubCurl(workDir, releaseDir)}:${process.env.PATH}`,
				// The installer makes its release host readonly, so a harness
				// cannot assign one: this is the seam it reads it from.
				WASMEDGE_AGENT_DOWNLOAD_BASE_URL: BASE_URL,
			},
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`, staged: "" };
	}

	return { status: 0, output: "", staged: readFileSync(resultPath, "utf-8").trim() };
}

/** What the installer hands npm, read back out of the tarball it built. */
function stagedManifest(workDir: string, tarball: string): Record<string, Record<string, string>> {
	const unpacked = join(workDir, "unpacked");
	mkdirSync(unpacked, { recursive: true });
	execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
	return JSON.parse(readFileSync(join(unpacked, "package", "package.json"), "utf-8"));
}

describe("installer release package verification", () => {
	it("resolves every internal package to a file it has checksummed", () => {
		// The release publishes four tarballs and SHA256SUMS covers all four,
		// but npm used to fetch three of them itself, from URLs, with no
		// integrity metadata and no lockfile to hold any.
		const { workDir, releaseDir, downloadDir } = stageRelease();

		const { status, staged } = runStaging(workDir, releaseDir, downloadDir);

		expect(status).toBe(0);
		expect(staged).not.toBe(join(downloadDir, ROOT_TARBALL));

		const manifest = stagedManifest(workDir, staged);
		expect(manifest.dependencies["@earendil-works/pi-ai"]).toBe(`file:${join(downloadDir, AI_TARBALL)}`);
		expect(manifest.optionalDependencies["@earendil-works/pi-tui"]).toBe(`file:${join(downloadDir, TUI_TARBALL)}`);
		expect(existsSync(join(downloadDir, AI_TARBALL))).toBe(true);
		expect(existsSync(join(downloadDir, TUI_TARBALL))).toBe(true);
	});

	it("leaves registry dependencies for npm to resolve", () => {
		// Only our own packages move. Everything else keeps the range it had,
		// and npm verifies those against the registry as it always did.
		const { workDir, releaseDir, downloadDir } = stageRelease();

		const { staged } = runStaging(workDir, releaseDir, downloadDir);

		expect(stagedManifest(workDir, staged).dependencies.chalk).toBe("^5.5.0");
	});

	it("refuses a package whose bytes do not match the checksums", () => {
		// The whole point. A dependency tarball replaced after SHA256SUMS was
		// written must stop the install, not install.
		const { workDir, releaseDir, downloadDir } = stageRelease();
		packageTarball(workDir, AI_TARBALL, { name: "wasmedge-agent-ai", version: VERSION, tampered: true });

		const { status, output } = runStaging(workDir, releaseDir, downloadDir);

		expect(status).not.toBe(0);
		expect(output).toMatch(/FAILED|checksum/i);
	});

	it("refuses a package SHA256SUMS says nothing about", () => {
		// An artifact that is not in the checksum file is one nothing has
		// vouched for, so it is not installable either.
		const { workDir, releaseDir, downloadDir } = stageRelease();
		writeChecksums(releaseDir, [ROOT_TARBALL, TUI_TARBALL]);

		const { status, output } = runStaging(workDir, releaseDir, downloadDir);

		expect(status).not.toBe(0);
		expect(output).toContain(`checksum for ${AI_TARBALL} was not found`);
	});

	it("installs the downloaded tarball as it is when nothing needs resolving", () => {
		// A release whose dependencies all come from the registry has nothing
		// for this step to verify, and repacking it would only be a way to get
		// it wrong.
		const { workDir, releaseDir, downloadDir } = stageRelease();
		packageTarball(workDir, ROOT_TARBALL, {
			name: "wasmedge-agent",
			version: VERSION,
			dependencies: { chalk: "^5.5.0" },
		});
		writeChecksums(releaseDir, [ROOT_TARBALL, AI_TARBALL, TUI_TARBALL]);

		const { status, staged } = runStaging(workDir, releaseDir, downloadDir);

		expect(status).toBe(0);
		expect(staged).toBe(join(downloadDir, ROOT_TARBALL));
	});
});
