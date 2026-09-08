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
		const name = options.installSpec.split("/").pop() || "package.tgz";
		const path = join(dir, name);
		await fetchVerified(options, options.installSpec, options.installSha256, path);
		const verified = [name];

		const staged = await stageInternalPackages(options, dir, path, verified);
		return { path: staged, cleanup, verified };
	} catch (error) {
		cleanup();
		throw error;
	}
}

/** Resolves the installed package's own release dependencies to local files.
 *
 *  The release publishes four tarballs. Three of them are dependencies of the
 *  fourth, spelled as URLs under the same release, and npm resolves those
 *  itself -- with no integrity metadata for a URL dependency and no lockfile
 *  in a global install to hold any. Verifying only the tarball named on the
 *  command line therefore covered a quarter of what arrived.
 *
 *  So they are fetched here, checked against the manifest that already
 *  publishes their digests, and written into the package as file: paths. npm
 *  installs those from disk and still resolves each package's own registry
 *  dependencies as before.
 *
 *  Returns the tarball to install: the downloaded one when the release names
 *  no packages of its own, and a repacked one when it does.
 */
async function stageInternalPackages(
	options: VerifiedReleasePackageOptions,
	dir: string,
	tarballPath: string,
	verified: string[],
): Promise<string> {
	const releasePrefix = options.installSpec.slice(0, options.installSpec.lastIndexOf("/") + 1);
	const root = join(dir, "staged");
	mkdirSync(root, { recursive: true });

	// Unpacked before the manifest can be read, and the manifest is what says
	// whether any of this is needed -- so tar is required by any release that
	// publishes its own packages, which is every release this fork builds.
	runTar(options, ["-xzf", tarballPath, "-C", root]);

	const manifestPath = join(root, "package", "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, Record<string, string>>;
	const internal: { name: string; field: string; file: string }[] = [];
	for (const field of ["dependencies", "optionalDependencies"]) {
		for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
			if (typeof spec !== "string" || !spec.startsWith(releasePrefix)) continue;
			internal.push({ name, field, file: spec.slice(releasePrefix.length) });
		}
	}

	if (internal.length === 0) {
		return tarballPath;
	}

	const digests = options.releaseDigests ?? {};
	for (const dependency of internal) {
		// The name becomes a URL and a path below. It comes out of a manifest
		// already checked against its own digest, so this is not load-bearing;
		// it costs nothing and keeps it from becoming so.
		if (!dependency.file || dependency.file.includes("/") || dependency.file.includes("..")) {
			throw new Error(
				`The release names an unusable file for ${dependency.name}: ${dependency.file}. Nothing was installed.`,
			);
		}
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
		manifest[dependency.field][dependency.name] = `file:${dependencyPath}`;
	}

	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	const repacked = join(dir, "repacked");
	mkdirSync(repacked, { recursive: true });
	const staged = join(repacked, tarballPath.split("/").pop() || "package.tgz");
	runTar(options, ["-czf", staged, "-C", root, "package"]);
	return staged;
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
