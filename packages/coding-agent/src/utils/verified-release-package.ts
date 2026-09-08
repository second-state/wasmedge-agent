/**
 * Fetching a release the way install.sh does: every package it installs is
 * checked against the digests the release published, not just the one named
 * on the command line.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SELF_UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;

/** A release package on disk, and the temporary tree it lives in. */
export interface VerifiedReleasePackage {
	path: string;
	cleanup: () => void;
	/** File names checked against a published digest, in fetch order. The
	 *  installed tarball is first; anything after it is a dependency this
	 *  release publishes beside it. */
	verified: string[];
}

export interface VerifiedReleasePackageOptions {
	/** The release URL to install, which is also where its sibling packages
	 *  live: everything under the same directory belongs to this release. */
	installSpec: string;
	/** The published digest for installSpec. */
	installSha256: string;
	/** Every artifact in the release, by file name, from the manifest. */
	releaseDigests?: Record<string, string>;
	/** What the release manifest says it is publishing: the version, the
	 *  package name it installs, and the package name behind each artifact
	 *  file. A digest says the bytes are the ones published under a file name,
	 *  and nothing about the package inside them, so these are what the
	 *  packages that arrive are held to. Each is checked only when the
	 *  manifest carries it. */
	expectedVersion?: string;
	expectedPackageName?: string;
	releasePackageNames?: Record<string, string>;
	fetchImpl?: typeof fetch;
	/** The tar to run. A parameter so a test can point it at something that is
	 *  not there, which is the case that has to fail closed. */
	tarCommand?: string;
	timeoutMs?: number;
}

/** Raised when tar is needed and missing, so the caller can say what to do. */
export class TarUnavailableError extends Error {}

export async function downloadVerifiedReleasePackage(
	options: VerifiedReleasePackageOptions,
): Promise<VerifiedReleasePackage> {
	const dir = mkdtempSync(join(tmpdir(), "wasmedge-agent-update-"));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	try {
		// The install spec is a URL, so its last segment is its file name
		// whatever the host runs on. Paths below use basename, which is not
		// the same question on Windows.
		const file = options.installSpec.split("/").pop() || "package.tgz";
		const path = join(dir, file);
		await fetchVerified(options, options.installSpec, options.installSha256, path);
		const verified = [file];

		const staged = await stageInternalPackages(options, dir, file, path, verified);
		return { path: staged, cleanup, verified };
	} catch (error) {
		cleanup();
		throw error;
	}
}

/** One package of this release, downloaded and checked. */
interface StagedPackage {
	/** The verified tarball as downloaded. */
	downloaded: string;
	/** Where it was unpacked, or undefined when it did not need to be. */
	unpacked?: string;
	/** Its dependencies on other packages of this release. */
	internal: { field: string; name: string; file: string }[];
}

/** Resolves every release package reachable from the installed one.
 *
 *  The release publishes four tarballs. Three of them are dependencies of the
 *  fourth, spelled as URLs under the same release, and npm resolves those
 *  itself -- with no integrity metadata for a URL dependency and no lockfile
 *  in a global install to hold any. Verifying only the tarball named on the
 *  command line therefore covered a quarter of what arrived.
 *
 *  The graph is walked rather than the root manifest alone, because those
 *  packages depend on each other too: the core package names the AI package
 *  by URL in its own manifest, so rewriting the root and stopping there left
 *  npm fetching one package the same unchecked way as before.
 *
 *  Every package is fetched, checked against the digest the release already
 *  publishes for it, and rewritten so each edge of that graph points at a
 *  local file. npm installs those from disk and still resolves each package's
 *  registry dependencies as before.
 *
 *  Returns the tarball to install: the downloaded one when the release names
 *  no packages of its own, and a repacked one when it does.
 */
async function stageInternalPackages(
	options: VerifiedReleasePackageOptions,
	dir: string,
	rootFile: string,
	rootPath: string,
	verified: string[],
): Promise<string> {
	const releasePrefix = options.installSpec.slice(0, options.installSpec.lastIndexOf("/") + 1);
	const digests = options.releaseDigests ?? {};
	const staged = new Map<string, StagedPackage>();
	// Every artifact of one release carries that release's version, so the
	// package installed sets what the packages it pulls in have to be.
	let rootVersion: string | undefined;
	const queue = [{ file: rootFile, downloaded: rootPath }];
	// Membership is recorded when a package is queued rather than when it is
	// staged: more than one package depends on the AI package, and a set that
	// only knew about staged ones would fetch and verify it once per
	// dependent.
	const seen = new Set([rootFile]);

	while (queue.length > 0) {
		const { file, downloaded } = queue.shift() as { file: string; downloaded: string };

		// Unpacked before its manifest can be read, and the manifest is what
		// says whether any of this is needed -- so tar is required by any
		// release that publishes packages of its own, which is every release
		// this fork builds.
		const unpacked = join(dir, "staged", file);
		mkdirSync(unpacked, { recursive: true });
		runTar(options, ["-xzf", downloaded, "-C", unpacked]);
		const manifest = readManifest(unpacked);
		const identity = assertPackageIdentity(options, file, manifest, file === rootFile ? undefined : rootVersion);
		if (file === rootFile) rootVersion = identity.version;
		const internal = internalDependencies(manifest, releasePrefix);
		staged.set(file, { downloaded, unpacked, internal });

		for (const dependency of internal) {
			if (seen.has(dependency.file)) continue;
			seen.add(dependency.file);
			assertUsableReleaseFile(dependency);
			const sha256 = digests[dependency.file];
			if (!sha256) {
				throw new Error(
					`The release manifest names ${dependency.file} as a dependency of the package being installed ` +
						"but publishes no SHA-256 for it, so it cannot be verified and nothing was installed.",
				);
			}
			const dependencyPath = join(dir, dependency.file);
			await fetchVerified(options, `${releasePrefix}${dependency.file}`, sha256, dependencyPath);
			verified.push(dependency.file);
			queue.push({ file: dependency.file, downloaded: dependencyPath });
		}
	}

	const root = staged.get(rootFile) as StagedPackage;
	if (root.internal.length === 0) {
		return root.downloaded;
	}

	// Where each package will be once this is done. Decided for all of them
	// before any manifest is written, because the graph has no order that
	// makes a package's own repacked path exist before a dependent needs to
	// name it: npm reads these paths at install time, when every one of them
	// is on disk.
	const repacked = join(dir, "repacked");
	mkdirSync(repacked, { recursive: true });
	const installPath = new Map<string, string>();
	for (const [file, entry] of staged) {
		installPath.set(file, entry.internal.length > 0 ? join(repacked, file) : entry.downloaded);
	}

	for (const [file, entry] of staged) {
		if (entry.internal.length === 0 || !entry.unpacked) continue;
		const manifest = readManifest(entry.unpacked);
		for (const dependency of entry.internal) {
			manifest[dependency.field][dependency.name] = `file:${installPath.get(dependency.file)}`;
		}
		writeFileSync(join(entry.unpacked, "package", "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		runTar(options, ["-czf", installPath.get(file) as string, "-C", entry.unpacked, "package"]);
	}

	return installPath.get(rootFile) as string;
}

/** Checks that a verified package is the package the release says it is.
 *
 *  A digest says these bytes are the ones published under this file name, and
 *  nothing about what is inside them. A release assembled with one artifact
 *  under another's name, or a manifest advertising a version its own package
 *  does not carry, passes every checksum here and installs the wrong package.
 *
 *  Held to what the manifest itself publishes rather than to the shape of the
 *  file name: the packer happens to name artifacts `<name>-<version>.tgz`, and
 *  a check built on that would reject a release that names its files any other
 *  way while proving nothing the manifest cannot say directly.
 *
 *  A package this release pulls in has to be named by the manifest: nothing
 *  else can say what it is. The dependent's manifest cannot -- it keys the
 *  dependency by its source package name, while the artifact carries the
 *  branded one -- and neither can the file name or the digest. The root is the
 *  exception: an update installs the tarball the manifest points at, so a
 *  manifest that does not name the package behind it leaves nothing to check
 *  it against.
 */
function assertPackageIdentity(
	options: VerifiedReleasePackageOptions,
	file: string,
	manifest: Record<string, Record<string, string>>,
	expectedVersion: string | undefined,
): { name: string; version: string } {
	const { name, version } = manifest as unknown as { name?: string; version?: string };
	if (typeof name !== "string" || typeof version !== "string") {
		throw new Error(`${file} declares no package name and version. Nothing was installed.`);
	}

	const isRoot = file === options.installSpec.split("/").pop();
	const expectedName = options.releasePackageNames?.[file] ?? (isRoot ? options.expectedPackageName : undefined);
	if (expectedName === undefined && !isRoot) {
		throw new Error(`The release manifest does not say which package ${file} should contain. Nothing was installed.`);
	}
	if (expectedName !== undefined && name !== expectedName) {
		throw new Error(`${file} should be ${expectedName} and contains ${name}. Nothing was installed.`);
	}

	const requiredVersion =
		expectedVersion ?? (file === options.installSpec.split("/").pop() ? options.expectedVersion : undefined);
	if (requiredVersion !== undefined && version !== requiredVersion) {
		throw new Error(`${file} should be version ${requiredVersion} and contains ${version}. Nothing was installed.`);
	}

	return { name, version };
}

function readManifest(unpacked: string): Record<string, Record<string, string>> {
	return JSON.parse(readFileSync(join(unpacked, "package", "package.json"), "utf-8"));
}

/** The manifest's dependencies on other packages of the same release. */
function internalDependencies(
	manifest: Record<string, Record<string, string>>,
	releasePrefix: string,
): { field: string; name: string; file: string }[] {
	const internal: { field: string; name: string; file: string }[] = [];
	for (const field of ["dependencies", "optionalDependencies"]) {
		for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
			if (typeof spec !== "string" || !spec.startsWith(releasePrefix)) continue;
			internal.push({ field, name, file: spec.slice(releasePrefix.length) });
		}
	}
	return internal;
}

/** The file name becomes a URL and a path. It comes out of a manifest already
 *  checked against its own digest, so this is not load-bearing; it costs
 *  nothing and keeps it from becoming so. */
function assertUsableReleaseFile(dependency: { name: string; file: string }): void {
	if (!dependency.file || dependency.file.includes("/") || dependency.file.includes("..")) {
		throw new Error(
			`The release names an unusable file for ${dependency.name}: ${dependency.file}. Nothing was installed.`,
		);
	}
}

/** Fetches one file and writes it only once its bytes match `sha256`.
 *
 *  Buffered rather than streamed to disk: the check has to happen before any
 *  of it reaches the package manager, so a partial file on disk would be a
 *  file something else could pick up. A release tarball is a few tens of
 *  megabytes at most.
 */
async function fetchVerified(
	options: VerifiedReleasePackageOptions,
	url: string,
	sha256: string,
	path: string,
): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(url, {
		signal: AbortSignal.timeout(options.timeoutMs ?? SELF_UPDATE_DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== sha256) {
		throw new Error(
			`The downloaded release does not match the checksum the manifest published for it. ` +
				`Expected ${sha256}, got ${actual}. Nothing was installed.`,
		);
	}
	writeFileSync(path, bytes);
}

/** Runs tar, and refuses the update rather than skipping verification.
 *
 *  A host without tar is a host this cannot verify on, and the alternative to
 *  failing here is installing three unchecked packages with a warning nobody
 *  reads. install.sh does the same work with the same tar, so pointing at it
 *  is a real instruction rather than a consolation.
 */
function runTar(options: VerifiedReleasePackageOptions, args: string[]): void {
	const command = options.tarCommand ?? "tar";
	const result = spawnSync(command, args, { encoding: "utf-8" });
	if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
		throw new TarUnavailableError(
			`${command} is needed to verify the packages in a release, and it is not on PATH. ` +
				"Nothing was installed. Reinstall with install.sh, which verifies the same packages.",
		);
	}
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}: ${result.stderr?.trim()}`);
	}
}
