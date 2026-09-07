import { readLegacyEnv } from "../config.js";
import { getPiUserAgent } from "./pi-user-agent.js";

/** No default, deliberately.
 *
 * The rebrand renamed this constant but not its value, which stayed upstream's
 * release bucket. checkForNewPiVersion runs on every interactive startup, and
 * package-manager-cli takes `packageName` and `installSpec` straight from the
 * manifest it fetches -- so a shipped WasmEdge Agent announced upstream's
 * version as an update to itself and, on /update, would have installed
 * upstream's own release tarball over itself.
 *
 * WasmEdge Agent has no release host yet, so there is no correct value to put
 * here. Empty is the honest one: it self-disables the update check, the same
 * way install.sh refuses to run against its unreplaced download-URL sentinel,
 * rather than silently querying a host we do not own. Set
 * WASMEDGE_AGENT_DOWNLOAD_BASE_URL, or fill this in, once a release host
 * exists. */
const DEFAULT_WASMEDGE_AGENT_DOWNLOAD_BASE_URL = "";
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

function getWasmEdgeAgentDownloadBaseUrl(): string {
	return (
		readLegacyEnv("WASMEDGE_AGENT_DOWNLOAD_BASE_URL")?.trim() || DEFAULT_WASMEDGE_AGENT_DOWNLOAD_BASE_URL
	).replace(/\/+$/, "");
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
				"Set WASMEDGE_AGENT_DOWNLOAD_BASE_URL to the WasmEdge Agent release base URL. " +
				"There is no default on purpose: the value this replaced was upstream's release bucket, " +
				"and querying it would offer upstream's build as an update to this one.",
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
		const sha256 = findTarballSha256(data.tarballs, data.tarball);
		if (sha256) {
			release.installSha256 = sha256;
		}
	}
	return release;
}

/** The manifest's SHA-256 for one tarball, matched on the file name that the
 *  `tarball` path ends with.
 *
 *  The manifest carries both: `tarball` is the path to install, and `tarballs`
 *  is every artifact in the release with its digest, which is also what
 *  SHA256SUMS is generated from. They are matched by file name rather than by
 *  package, because `tarball` is a path and the package field beside it names
 *  the package the release publishes rather than the file. */
function findTarballSha256(tarballs: unknown, tarballPath: unknown): string | undefined {
	if (!Array.isArray(tarballs) || typeof tarballPath !== "string") return undefined;
	const file = tarballPath.trim().split("/").pop();
	if (!file) return undefined;
	for (const entry of tarballs) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { file?: unknown; sha256?: unknown };
		if (candidate.file !== file || typeof candidate.sha256 !== "string") continue;
		const sha256 = candidate.sha256.trim().toLowerCase();
		if (/^[0-9a-f]{64}$/.test(sha256)) return sha256;
	}
	return undefined;
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
