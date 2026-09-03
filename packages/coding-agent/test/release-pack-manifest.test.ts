import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createReleasePackageJson,
	missingReleaseArtifacts,
	PUBLIC_BIN_TARGET,
	PUBLIC_LEGACY_BIN_TARGET,
	writeLegacyAliasShim,
} from "../../../scripts/pack-wasmedge-agent-release.mjs";
import { LEGACY_ALIAS_ENV } from "../src/config.js";

const repoRoot = resolve(__dirname, "../../..");

/** The release manifest the packer generates.
 *
 *  The end-to-end alias test proves what the binary does once a command name
 *  points at it. This proves the other half: that the release actually installs
 *  that name. Nothing else does -- the packed bin map is exactly the thing that
 *  was missing when the CHANGELOG first promised the alias would keep working,
 *  and it is invisible to every test that builds its own symlink.
 */
describe("release package manifest", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const sourcePackage = JSON.parse(
		readFileSync(join(repoRoot, "packages", "coding-agent", "package.json"), "utf-8"),
	) as Record<string, unknown>;

	function releaseManifest(packageName: string): Record<string, unknown> {
		return createReleasePackageJson(sourcePackage, packageName, "9.9.9", new Map());
	}

	it("installs the canonical command and the legacy alias, each at its own entry", () => {
		const bin = releaseManifest("wasmedge-agent").bin as Record<string, string>;

		// The alias must not share the canonical entry. npm's POSIX bin symlink
		// carries the invoked name in argv[1], but its Windows .cmd and
		// PowerShell shims launch node with the target path, so an alias
		// pointing there cannot tell it was invoked as the alias and the
		// deprecation notice never fires on that platform.
		expect(bin).toEqual({
			"wasmedge-agent": "dist/bundle/cli.js",
			"prime-agent": "dist/bundle/prime-agent.js",
		});
	});

	it("names the packed entries that actually ship", () => {
		const bin = releaseManifest("wasmedge-agent").bin as Record<string, string>;
		const files = releaseManifest("wasmedge-agent").files as string[];

		// The packed `files` list has to carry the directory holding both, or
		// the bin entries dangle on install.
		expect(new Set(Object.values(bin))).toEqual(new Set([PUBLIC_BIN_TARGET, PUBLIC_LEGACY_BIN_TARGET]));
		expect(files).toContain("dist");
		// ...and the canonical one is the same constant the pack-time build
		// check requires, so the two cannot drift apart.
		expect(PUBLIC_BIN_TARGET).toBe("dist/bundle/cli.js");
		expect(PUBLIC_LEGACY_BIN_TARGET).toBe("dist/bundle/prime-agent.js");
	});

	it("writes the alias entry point into the staged package", () => {
		// The bin map above promises this file exists in the tarball. Nothing
		// builds it -- the packer writes it -- so nothing else would notice if
		// it stopped being written.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-pack-"));
		tempDirs.push(packageRoot);

		const written = writeLegacyAliasShim(packageRoot);

		expect(written).toBe(join(packageRoot, PUBLIC_LEGACY_BIN_TARGET));
		// A real file where the bin entry points, which is what the pack-time
		// check demands of the canonical target and would demand of this one.
		expect(missingReleaseArtifacts(packageRoot, [PUBLIC_LEGACY_BIN_TARGET])).toEqual([]);

		const source = readFileSync(written, "utf-8");
		// The marker the running CLI reads, spelled the same way. The packer is
		// plain JavaScript and cannot import the constant, so this assertion is
		// what keeps the two ends of the handshake together.
		expect(source).toContain(`process.env.${LEGACY_ALIAS_ENV} =`);
		// It has to reach the real entry, and set the marker before it does --
		// a static import would be hoisted above the assignment.
		expect(source).toContain('await import("./cli.js")');
		expect(source.startsWith("#!")).toBe(true);
		expect(statSync(written).mode & 0o111).not.toBe(0);
	});

	it("refuses to pack a package whose bin target is not built", () => {
		// A dist directory alone is not enough: it is what the check used to
		// accept, and it lets both commands point at a file the tarball does
		// not carry -- a package that installs and fails on first run, with
		// nothing reported at pack time.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-pack-"));
		tempDirs.push(packageRoot);
		mkdirSync(join(packageRoot, "dist"), { recursive: true });

		expect(missingReleaseArtifacts(packageRoot, [PUBLIC_BIN_TARGET])).toEqual([join(packageRoot, PUBLIC_BIN_TARGET)]);

		mkdirSync(dirname(join(packageRoot, PUBLIC_BIN_TARGET)), { recursive: true });
		writeFileSync(join(packageRoot, PUBLIC_BIN_TARGET), "#!/usr/bin/env node\n");

		expect(missingReleaseArtifacts(packageRoot, [PUBLIC_BIN_TARGET])).toEqual([]);
	});

	it("rejects a directory standing where the command target should be", () => {
		// existsSync is satisfied by this, which is the point: a bin entry
		// pointing at a directory installs and then cannot be run, and neither
		// npm nor the old check says a word.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-pack-"));
		tempDirs.push(packageRoot);
		mkdirSync(join(packageRoot, PUBLIC_BIN_TARGET), { recursive: true });
		expect(existsSync(join(packageRoot, PUBLIC_BIN_TARGET))).toBe(true);

		expect(missingReleaseArtifacts(packageRoot, [PUBLIC_BIN_TARGET])).toEqual([join(packageRoot, PUBLIC_BIN_TARGET)]);
	});

	it("rejects a file standing where the dist tree should be", () => {
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-pack-"));
		tempDirs.push(packageRoot);
		writeFileSync(join(packageRoot, "dist"), "not a directory");

		expect(missingReleaseArtifacts(packageRoot)).toEqual([join(packageRoot, "dist")]);
	});

	it("still reports a missing dist, and reports both when both are gone", () => {
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-pack-"));
		tempDirs.push(packageRoot);

		expect(missingReleaseArtifacts(packageRoot, [PUBLIC_BIN_TARGET])).toEqual([
			join(packageRoot, "dist"),
			join(packageRoot, PUBLIC_BIN_TARGET),
		]);
		// An internal workspace package installs no command, so it is asked for
		// no bin target.
		expect(missingReleaseArtifacts(packageRoot)).toEqual([join(packageRoot, "dist")]);
	});

	it("points piConfig at the renamed command and config directory", () => {
		const manifest = releaseManifest("wasmedge-agent");

		expect(manifest.piConfig).toMatchObject({ name: "wasmedge-agent", configDir: ".wasmedge-agent" });
	});

	it("leaves the internal workspace packages' bin maps alone", () => {
		// Only the public package installs commands; the alias must not leak
		// into a dependency's manifest, where it would take the name a second
		// time.
		const manifest = releaseManifest("wasmedge-agent-ai");

		expect(manifest.bin).toEqual(sourcePackage.bin);
	});
});
