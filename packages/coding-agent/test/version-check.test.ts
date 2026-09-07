import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

// There is no compiled-in release host any more, so every test that expects a
// fetch has to say which host it expects one against.
const configuredDownloadBaseUrl = "https://releases.example.test";
const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;
const originalWasmEdgeAgentDownloadBaseUrl = process.env.WASMEDGE_AGENT_DOWNLOAD_BASE_URL;
const originalLegacyWasmEdgeAgentDownloadBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

beforeEach(() => {
	process.env.WASMEDGE_AGENT_DOWNLOAD_BASE_URL = configuredDownloadBaseUrl;
});

afterEach(() => {
	vi.unstubAllGlobals();
	restoreEnv("PI_SKIP_VERSION_CHECK", originalSkipVersionCheck);
	restoreEnv("PI_OFFLINE", originalOffline);
	restoreEnv("WASMEDGE_AGENT_DOWNLOAD_BASE_URL", originalWasmEdgeAgentDownloadBaseUrl);
	restoreEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", originalLegacyWasmEdgeAgentDownloadBaseUrl);
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("0.70.5-beta.10.1.abcdef0", "0.70.5-beta.9.1.1234567")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses the WasmEdge Agent release manifest with a WasmEdge Agent user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`${configuredDownloadBaseUrl}/latest.json`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^wasmedge-agent\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("falls back to PRIME_AGENT_DOWNLOAD_BASE_URL for one release when the current name is unset", async () => {
		delete process.env.WASMEDGE_AGENT_DOWNLOAD_BASE_URL;
		process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = "https://legacy.example.test";
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith("https://legacy.example.test/latest.json", expect.any(Object));
	});

	it("keeps beta installations on the beta release manifest", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4-beta.124.1.abcdef0" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.4-beta.123.1.1234567")).resolves.toBe("1.2.4-beta.124.1.abcdef0");
		expect(fetchMock).toHaveBeenCalledWith(`${configuredDownloadBaseUrl}/beta.json`, expect.any(Object));
	});

	it("returns the active package and tarball install spec from the release manifest", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				package: "wasmedge-agent",
				tarball: "releases/v1.2.4/wasmedge-agent-1.2.4.tgz",
				version: "v1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			installSpec: `${configuredDownloadBaseUrl}/releases/v1.2.4/wasmedge-agent-1.2.4.tgz`,
			packageName: "wasmedge-agent",
			version: "1.2.4",
		});
	});

	it("refuses to run the update check when no release host is configured", async () => {
		// The value this replaced was upstream's release bucket. Left in place,
		// every interactive startup asked upstream for the latest version, and
		// /update would have installed upstream's own release tarball over this
		// build, because package-manager-cli takes the package name and the
		// install spec straight out of that manifest.
		delete process.env.WASMEDGE_AGENT_DOWNLOAD_BASE_URL;
		delete process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		// Loud where a caller can act on it: the message names the variable to
		// set and says why there is no default.
		await expect(getLatestPiRelease("1.2.3")).rejects.toThrow(/WASMEDGE_AGENT_DOWNLOAD_BASE_URL/);
		// Quiet where it would only be noise: startup self-disables instead.
		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		// Either way, nothing is fetched from a host we do not own.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
