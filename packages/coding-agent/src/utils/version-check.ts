import { RELEASE_DOWNLOAD_BASE_URL, readLegacyEnv } from "../config.js";
import { getPiUserAgent } from "./pi-user-agent.js";

const STABLE_VERSION_MANIFEST_PATH = "latest.json";
const BETA_VERSION_MANIFEST_PATH = "beta.json";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	installSpec?: string;
	/** The manifest's SHA-256 for the tarball `installSpec` names, when it
	 *  names one. Set only for a hex digest of the right length -- a field the
	 *  host filled in with something else is no better than a missing one, and
	 *  the caller has to be able to tell "the host did not say" apart from
	 *  "the host said something unusable". */
	installSha256?: string;
	/** Every artifact in the release, by file name, with the same digests
	 *  SHA256SUMS is generated from. The tarball `installSpec` names has its
	 *  own dependencies published beside it, and they are packages that get
	 *  installed too, so the caller needs more than one digest to check
	 *  everything that lands. Same validation as installSha256: an entry the
	 *  host filled in with something unusable is left out. */
	releaseDigests?: Record<string, string>;
	/** Each artifact's package name, by file name, from the same list. The
	 *  digest says the bytes are the ones published under that file name; this
	 *  is what says which package the release meant that file to be. */
	releasePackageNames?: Record<string, string>;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function comparePrereleaseIdentifiers(leftPrerelease: string, rightPrerelease: string): number {
	const leftIdentifiers = leftPrerelease.split(".");
	const rightIdentifiers = rightPrerelease.split(".");
	const length = Math.max(leftIdentifiers.length, rightIdentifiers.length);

	for (let index = 0; index < length; index += 1) {
		const left = leftIdentifiers[index];
		const right = rightIdentifiers[index];
		if (left === right) continue;
		if (left === undefined) return -1;
		if (right === undefined) return 1;

		const leftIsNumeric = /^\d+$/.test(left);
		const rightIsNumeric = /^\d+$/.test(right);
		if (leftIsNumeric && rightIsNumeric) {
			const leftNumber = left.replace(/^0+(?=\d)/, "");
			const rightNumber = right.replace(/^0+(?=\d)/, "");
			if (leftNumber.length !== rightNumber.length) return leftNumber.length - rightNumber.length;
			const comparison = leftNumber.localeCompare(rightNumber);
			if (comparison !== 0) return comparison;
			continue;
		}
		if (leftIsNumeric) return -1;
		if (rightIsNumeric) return 1;
		return left.localeCompare(right);
	}

	return 0;
}

function parsePackageVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}

	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

/** The release host to ask, or "" when there is none to ask.
 *
 *  The environment first, then the host recorded in the manifest by the packer
 *  that built this artifact. There is deliberately no constant behind those
 *  two: the value this replaced was upstream's release bucket, and a shipped
 *  WasmEdge Agent querying it announced upstream's version as an update to
 *  itself and, on /update, would have installed upstream's release over
 *  itself. A source checkout has no recorded host and gets "", which
 *  self-disables the check rather than asking a host we do not own. */
function getWasmEdgeAgentDownloadBaseUrl(): string {
	return (readLegacyEnv("WASMEDGE_AGENT_DOWNLOAD_BASE_URL")?.trim() || RELEASE_DOWNLOAD_BASE_URL).replace(/\/+$/, "");
}

function normalizeReleaseVersion(version: string): string {
	return version.trim().replace(/^v/, "");
}

function getReleaseManifestPath(currentVersion: string): string {
	const prerelease = parsePackageVersion(currentVersion)?.prerelease;
	return prerelease?.match(/^beta(?:\.|$)/) ? BETA_VERSION_MANIFEST_PATH : STABLE_VERSION_MANIFEST_PATH;
}

function resolveReleaseUrl(baseUrl: string, pathOrUrl: string): string | undefined {
	const trimmed = pathOrUrl.trim();
	if (!trimmed) return undefined;
	try {
		return new URL(trimmed).toString();
	} catch {
		return `${baseUrl}/${trimmed.replace(/^\/+/, "")}`;
	}
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	const baseUrl = getWasmEdgeAgentDownloadBaseUrl();
	// Throws rather than returning undefined so the reason is legible to
	// anyone who calls this directly or runs /update. checkForNewPiVersion
	// below still swallows it, which is what keeps a build with no release
	// host from printing a warning on every interactive startup -- the
	// diagnosis lives in this message, not in the terminal of every user.
	if (!baseUrl) {
		throw new Error(
			"No release host is configured, so the update check cannot run. " +
				"A packed release records the host it was published to; this build carries none, " +
				"which is what a source checkout looks like. " +
				"Set WASMEDGE_AGENT_DOWNLOAD_BASE_URL to the WasmEdge Agent release base URL to override it. " +
				"There is no compiled-in default on purpose: the value this replaced was upstream's release " +
				"bucket, and querying it would offer upstream's build as an update to this one.",
		);
	}
	const response = await fetch(`${baseUrl}/${getReleaseManifestPath(currentVersion)}`, {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		package?: unknown;
		packageName?: unknown;
		tarball?: unknown;
		tarballs?: unknown;
		version?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.package === "string" && data.package.trim()
			? data.package.trim()
			: typeof data.packageName === "string" && data.packageName.trim()
				? data.packageName.trim()
				: undefined;
	const installSpec = typeof data.tarball === "string" ? resolveReleaseUrl(baseUrl, data.tarball) : undefined;
	const release: LatestPiRelease = { version: normalizeReleaseVersion(data.version) };
	if (packageName) {
		release.packageName = packageName;
	}
	if (installSpec) {
		release.installSpec = installSpec;
		const digests = collectTarballDigests(data.tarballs);
		const packageNames = collectTarballPackageNames(data.tarballs);
		const file = typeof data.tarball === "string" ? data.tarball.trim().split("/").pop() : undefined;
		const sha256 = file ? digests[file] : undefined;
		if (sha256) {
			release.installSha256 = sha256;
		}
		if (Object.keys(digests).length > 0) {
			release.releaseDigests = digests;
		}
		if (Object.keys(packageNames).length > 0) {
			release.releasePackageNames = packageNames;
		}
	}
	return release;
}

/** The manifest's artifacts as file name to SHA-256.
 *
 *  The manifest carries both: `tarball` is the path to install, and `tarballs`
 *  is every artifact in the release with its digest, which is also what
 *  SHA256SUMS is generated from. Keyed by file name rather than by package,
 *  because `tarball` is a path and the package field beside it names the
 *  package the release publishes rather than the file -- and because the
 *  dependencies inside a release package name files too.
 *
 *  An entry whose digest is not a hex digest of the right length is dropped:
 *  a caller has to be able to tell "the release did not say" apart from "the
 *  release said something unusable", and both leave the file unverifiable. */
function collectTarballPackageNames(tarballs: unknown): Record<string, string> {
	const names: Record<string, string> = {};
	if (!Array.isArray(tarballs)) return names;
	for (const entry of tarballs) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { file?: unknown; package?: unknown };
		if (typeof candidate.file !== "string" || typeof candidate.package !== "string") continue;
		if (candidate.package.trim()) names[candidate.file] = candidate.package.trim();
	}
	return names;
}

function collectTarballDigests(tarballs: unknown): Record<string, string> {
	const digests: Record<string, string> = {};
	if (!Array.isArray(tarballs)) return digests;
	for (const entry of tarballs) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { file?: unknown; sha256?: unknown };
		if (typeof candidate.file !== "string" || typeof candidate.sha256 !== "string") continue;
		const sha256 = candidate.sha256.trim().toLowerCase();
		if (/^[0-9a-f]{64}$/.test(sha256)) digests[candidate.file] = sha256;
	}
	return digests;
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<string | undefined> {
	try {
		const latestVersion = await getLatestPiVersion(currentVersion);
		if (latestVersion && isNewerPackageVersion(latestVersion, currentVersion)) {
			return latestVersion;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
