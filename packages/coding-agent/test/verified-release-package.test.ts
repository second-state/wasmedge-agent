import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadVerifiedReleasePackage, TarUnavailableError } from "../src/utils/verified-release-package.js";

const BASE = "https://releases.example.test/releases/v9.9.9";
const ROOT = "wasmedge-agent-9.9.9.tgz";
const AI = "wasmedge-agent-ai-9.9.9.tgz";
const TUI = "wasmedge-agent-tui-9.9.9.tgz";
const CORE = "wasmedge-agent-core-9.9.9.tgz";

const tempDirs: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tarball(workDir: string, file: string, manifest: Record<string, unknown>): Buffer {
	const stage = join(workDir, "stage", file);
	mkdirSync(join(stage, "package"), { recursive: true });
	writeFileSync(join(stage, "package", "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	const path = join(workDir, file);
	execFileSync("tar", ["-czf", path, "-C", stage, "package"]);
	return readFileSync(path);
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** A release: the public tarball, the two packages it depends on by URL, and
 *  the digests the manifest publishes for all three. */
function stageRelease(rootManifest?: Record<string, unknown>) {
	const workDir = mkdtempSync(join(tmpdir(), "verified-release-"));
	tempDirs.push(workDir);

	const files = new Map<string, Buffer>();
	files.set(AI, tarball(workDir, AI, { name: "wasmedge-agent-ai", version: "9.9.9" }));
	files.set(TUI, tarball(workDir, TUI, { name: "wasmedge-agent-tui", version: "9.9.9" }));
	// The shape that made rewriting the root manifest alone insufficient: a
	// release package that names another one by URL in its own manifest.
	files.set(
		CORE,
		tarball(workDir, CORE, {
			name: "wasmedge-agent-core",
			version: "9.9.9",
			dependencies: { "@earendil-works/pi-ai": `${BASE}/${AI}`, typebox: "^1.1.24" },
		}),
	);
	files.set(
		ROOT,
		tarball(
			workDir,
			ROOT,
			rootManifest ?? {
				name: "wasmedge-agent",
				version: "9.9.9",
				dependencies: {
					"@earendil-works/pi-agent-core": `${BASE}/${CORE}`,
					"@earendil-works/pi-ai": `${BASE}/${AI}`,
					chalk: "^5.5.0",
				},
				optionalDependencies: { "@earendil-works/pi-tui": `${BASE}/${TUI}` },
			},
		),
	);

	const digests: Record<string, string> = {};
	for (const [file, bytes] of files) digests[file] = sha256(bytes);

	const fetchImpl = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		const bytes = files.get(url.split("/").pop() ?? "");
		return bytes ? new Response(bytes) : new Response(null, { status: 404 });
	}) as typeof fetch;

	return { workDir, files, digests, fetchImpl };
}

function stagedManifest(workDir: string, tarballPath: string, into = "unpacked"): Record<string, Record<string, string>> {
	const unpacked = join(workDir, into);
	mkdirSync(unpacked, { recursive: true });
	execFileSync("tar", ["-xzf", tarballPath, "-C", unpacked]);
	return JSON.parse(readFileSync(join(unpacked, "package", "package.json"), "utf-8"));
}

describe("verified release package", () => {
	it("verifies the packages the release tarball depends on", async () => {
		// The manifest publishes a digest for all four artifacts, and the
		// update path used to check one of them. The other three are
		// dependencies of it, spelled as URLs, and npm has no integrity
		// metadata for those.
		const { workDir, digests, fetchImpl } = stageRelease();

		const staged = await downloadVerifiedReleasePackage({
			installSpec: `${BASE}/${ROOT}`,
			installSha256: digests[ROOT],
			releaseDigests: digests,
			fetchImpl,
		});
		cleanups.push(staged.cleanup);

		expect([...staged.verified].sort()).toEqual([AI, CORE, ROOT, TUI].sort());
		const manifest = stagedManifest(workDir, staged.path);
		expect(manifest.dependencies["@earendil-works/pi-ai"]).toMatch(/^file:.*wasmedge-agent-ai-9\.9\.9\.tgz$/);
		expect(manifest.optionalDependencies["@earendil-works/pi-tui"]).toMatch(
			/^file:.*wasmedge-agent-tui-9\.9\.9\.tgz$/,
		);
		expect(existsSync(manifest.dependencies["@earendil-works/pi-ai"].slice("file:".length))).toBe(true);
		// Registry dependencies keep their range: npm resolves those against
		// the registry, which checks its own integrity metadata.
		expect(manifest.dependencies.chalk).toBe("^5.5.0");
	});

	it("rewrites a release package that depends on another one", async () => {
		// The core package names the AI package by URL in its own manifest.
		// Rewriting the root and stopping there left that edge for npm to
		// fetch, unchecked, which is the thing this exists to prevent.
		const { workDir, digests, fetchImpl } = stageRelease();

		const staged = await downloadVerifiedReleasePackage({
			installSpec: `${BASE}/${ROOT}`,
			installSha256: digests[ROOT],
			releaseDigests: digests,
			fetchImpl,
		});
		cleanups.push(staged.cleanup);

		const corePath = stagedManifest(workDir, staged.path).dependencies["@earendil-works/pi-agent-core"];
		expect(corePath).toMatch(/^file:/);
		const core = stagedManifest(workDir, corePath.slice("file:".length), "unpacked-core");

		expect(core.dependencies["@earendil-works/pi-ai"]).toMatch(/^file:.*wasmedge-agent-ai-9\.9\.9\.tgz$/);
		expect(core.dependencies.typebox).toBe("^1.1.24");
	});

	it("refuses a package reachable only through another release package", async () => {
		// The digest the root's own dependencies need is present; the one the
		// core package needs is not. A walk that stops at the root would not
		// notice.
		const { digests, fetchImpl } = stageRelease({
			name: "wasmedge-agent",
			version: "9.9.9",
			dependencies: { "@earendil-works/pi-agent-core": `${BASE}/${CORE}` },
		});
		const withoutAi = { ...digests };
		delete withoutAi[AI];

		await expect(
			downloadVerifiedReleasePackage({
				installSpec: `${BASE}/${ROOT}`,
				installSha256: digests[ROOT],
				releaseDigests: withoutAi,
				fetchImpl,
			}),
		).rejects.toThrow(/publishes no SHA-256 for it/);
	});

	it("refuses a package the release says is a different package", async () => {
		// A digest says the bytes are the ones published under that file name,
		// and nothing about what is inside them. The manifest names the
		// package behind each file, and that is what catches a release
		// assembled with one artifact under another's name.
		const { workDir, files, digests, fetchImpl } = stageRelease();
		const swapped = tarball(workDir, AI, { name: "wasmedge-agent-tui", version: "9.9.9" });
		files.set(AI, swapped);

		await expect(
			downloadVerifiedReleasePackage({
				installSpec: `${BASE}/${ROOT}`,
				installSha256: digests[ROOT],
				releaseDigests: { ...digests, [AI]: sha256(swapped) },
				releasePackageNames: { [AI]: "wasmedge-agent-ai" },
				fetchImpl,
			}),
		).rejects.toThrow(/should be wasmedge-agent-ai and contains wasmedge-agent-tui/);
	});

	it("refuses a package that is not the release's version", async () => {
		// Every artifact of a release carries that release's version, so the
		// package being installed sets what the packages it pulls in must be.
		const { workDir, files, digests, fetchImpl } = stageRelease();
		const older = tarball(workDir, AI, { name: "wasmedge-agent-ai", version: "8.8.8" });
		files.set(AI, older);

		await expect(
			downloadVerifiedReleasePackage({
				installSpec: `${BASE}/${ROOT}`,
				installSha256: digests[ROOT],
				releaseDigests: { ...digests, [AI]: sha256(older) },
				fetchImpl,
			}),
		).rejects.toThrow(/should be version 9\.9\.9 and contains 8\.8\.8/);
	});

	it("refuses a release whose package is not the version the manifest names", async () => {
		// The manifest can advertise one version and point at a package
		// carrying another; both are internally consistent, and the update
		// would install something other than what it reported.
		const { digests, fetchImpl } = stageRelease();

		await expect(
			downloadVerifiedReleasePackage({
				installSpec: `${BASE}/${ROOT}`,
				installSha256: digests[ROOT],
				releaseDigests: digests,
				expectedVersion: "10.0.0",
				fetchImpl,
			}),
		).rejects.toThrow(/should be version 10\.0\.0 and contains 9\.9\.9/);
	});

	it("refuses a dependency whose bytes do not match the manifest", async () => {
		const { digests, fetchImpl } = stageRelease();
		const tampered = { ...digests, [AI]: sha256(Buffer.from("not the package that was published")) };

		await expect(
			downloadVerifiedReleasePackage({
				installSpec: `${BASE}/${ROOT}`,
				installSha256: digests[ROOT],
				releaseDigests: tampered,
				fetchImpl,
			}),
		).rejects.toThrow(/does not match the checksum/);
	});

	it("refuses a dependency the release publishes no digest for", async () => {
		// An artifact nothing has vouched for is not installable, the same way
		// install.sh refuses a file SHA256SUMS does not mention.
		const { digests, fetchImpl } = stageRelease();
		const withoutAi = { ...digests };
		delete withoutAi[AI];

		await expect(
			downloadVerifiedReleasePackage({
				installSpec: `${BASE}/${ROOT}`,
				installSha256: digests[ROOT],
				releaseDigests: withoutAi,
				fetchImpl,
			}),
		).rejects.toThrow(/publishes no SHA-256 for it/);
	});

	it("installs the downloaded tarball when the release has no packages of its own", async () => {
		// Nothing to verify beyond the tarball itself, and repacking it would
		// only be a way to get it wrong.
		const { digests, fetchImpl } = stageRelease({
			name: "wasmedge-agent",
			version: "9.9.9",
			dependencies: { chalk: "^5.5.0" },
		});

		const staged = await downloadVerifiedReleasePackage({
			installSpec: `${BASE}/${ROOT}`,
			installSha256: digests[ROOT],
			releaseDigests: digests,
			fetchImpl,
		});
		cleanups.push(staged.cleanup);

		expect(staged.verified).toEqual([ROOT]);
		expect(staged.path.endsWith(`/${ROOT}`)).toBe(true);
		expect(staged.path).not.toContain("repacked");
	});

	it("refuses to update when tar is missing rather than installing unverified packages", async () => {
		// The fail-closed half of the decision. Falling back would install
		// three unchecked packages behind a warning, and install.sh does the
		// same work with the same tar, so pointing at it is a real
		// instruction.
		const { digests, fetchImpl } = stageRelease();

		const failure = downloadVerifiedReleasePackage({
			installSpec: `${BASE}/${ROOT}`,
			installSha256: digests[ROOT],
			releaseDigests: digests,
			fetchImpl,
			tarCommand: "wasmedge-agent-tar-that-is-not-installed",
		});

		await expect(failure).rejects.toThrow(TarUnavailableError);
		await expect(failure).rejects.toThrow(/install\.sh/);
	});

	it("leaves nothing behind when it refuses", async () => {
		// The temporary tree holds a verified tarball and a half-resolved
		// package. A refused update must not leave either where a later step
		// could pick it up.
		const { digests, fetchImpl } = stageRelease();
		const before = existingUpdateDirs();

		await expect(
			downloadVerifiedReleasePackage({
				installSpec: `${BASE}/${ROOT}`,
				installSha256: digests[ROOT],
				releaseDigests: { ...digests, [AI]: sha256(Buffer.from("replaced")) },
				fetchImpl,
			}),
		).rejects.toThrow();

		expect(existingUpdateDirs()).toEqual(before);
	});
});

/** The update staging directories present in the system temp directory. */
function existingUpdateDirs(): string[] {
	return readdirSync(tmpdir())
		.filter((name) => name.startsWith("wasmedge-agent-update-"))
		.sort();
}
