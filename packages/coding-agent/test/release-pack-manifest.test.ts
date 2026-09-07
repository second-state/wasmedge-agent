import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createReleasePackageJson,
	declaredEntryPoints,
	missingReleaseArtifacts,
	missingSourceOutputs,
	PUBLIC_BIN_TARGET,
	PUBLIC_LEGACY_BIN_TARGET,
	staleBuildOutputs,
	symlinkedBuildOutputs,
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

	function releaseManifest(packageName: string, downloadBaseUrl?: string): Record<string, unknown> {
		return createReleasePackageJson(sourcePackage, packageName, "9.9.9", new Map(), downloadBaseUrl);
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

	/** Plants build output whose source is gone -- what a rename leaves behind
	 *  in a workspace that was built before it and packed after.
	 *
	 *  Neither tsgo nor the asset copy deletes the output of a source file that
	 *  no longer exists, and the packer copies dist whole, so these files reach
	 *  the tarball. The branding audit cannot see them: it reads tracked source
	 *  files, and these are build output. */
	function packageWithRenamedSource(): string {
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-stale-"));
		tempDirs.push(packageRoot);
		mkdirSync(join(packageRoot, "src", "themes"), { recursive: true });
		mkdirSync(join(packageRoot, "dist", "themes"), { recursive: true });
		// The shape of the rename this fork actually made: a logo module took a
		// new name, and its outputs under the old one stayed in dist. Spelled
		// with a stand-in name, because the audit that reads this file bans the
		// real one and a fixture is not worth an allowlist entry.
		writeFileSync(join(packageRoot, "src", "themes", "wasmedge-logo.ts"), "export const logo = '';\n");
		writeFileSync(join(packageRoot, "dist", "themes", "wasmedge-logo.js"), "export const logo = '';\n");
		return packageRoot;
	}

	it("refuses to pack build output whose source was renamed away", () => {
		const packageRoot = packageWithRenamedSource();
		expect(staleBuildOutputs(packageRoot)).toEqual([]);

		writeFileSync(join(packageRoot, "dist", "themes", "legacy-logo.js"), "export const logo = '';\n");
		writeFileSync(join(packageRoot, "dist", "themes", "legacy-logo.d.ts"), "export declare const logo: string;\n");

		expect(staleBuildOutputs(packageRoot)).toEqual([
			join(packageRoot, "dist", "themes", "legacy-logo.d.ts"),
			join(packageRoot, "dist", "themes", "legacy-logo.js"),
		]);
	});

	it("catches a copied asset whose source was renamed away, not only a compiled one", () => {
		// The other half of the reproduced failure: copy-assets copies the theme
		// JSON across by name, so a renamed theme leaves its old file in dist
		// exactly the way a renamed module leaves its old .js.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-stale-asset-"));
		tempDirs.push(packageRoot);
		const themeSource = join(packageRoot, "src", "modes", "interactive", "theme");
		const themeOutput = join(packageRoot, "dist", "modes", "interactive", "theme");
		mkdirSync(themeSource, { recursive: true });
		mkdirSync(themeOutput, { recursive: true });
		writeFileSync(join(themeSource, "wasmedge.json"), "{}\n");
		writeFileSync(join(themeOutput, "wasmedge.json"), "{}\n");
		expect(staleBuildOutputs(packageRoot)).toEqual([]);

		writeFileSync(join(themeOutput, "prime.json"), "{}\n");

		expect(staleBuildOutputs(packageRoot)).toEqual([join(themeOutput, "prime.json")]);
	});

	it("catches a whole output tree whose source directory was removed", () => {
		// The check used to skip any dist file whose source directory was
		// absent, on the theory that such a tree was generated. A renamed or
		// deleted src directory looks exactly like that from dist, so the whole
		// stale tree walked through. Generated trees are named in the rule table
		// now, and a missing source directory means what it says.
		const packageRoot = packageWithRenamedSource();
		const removed = join(packageRoot, "dist", "removed");
		mkdirSync(removed, { recursive: true });
		writeFileSync(join(removed, "old.js"), "export const old = '';\n");
		writeFileSync(join(removed, "old.png"), "");

		expect(staleBuildOutputs(packageRoot)).toEqual([join(removed, "old.js"), join(removed, "old.png")]);
	});

	/** Every kind of file the build copies into dist unchanged.
	 *
	 *  The check used to carry a list of seven suffixes and ignore anything
	 *  outside it, so a stale .png or .md was invisible to it. A copied file is
	 *  looked for under its own name now, whatever that name ends in, and the
	 *  suffix table is only for outputs named differently from their source. */
	it.each([".png", ".json", ".css", ".html", ".js", ".md", ".wasm"])(
		"checks a copied %s under its own name",
		(extension) => {
			const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-copied-"));
			tempDirs.push(packageRoot);
			mkdirSync(join(packageRoot, "src", "media"), { recursive: true });
			mkdirSync(join(packageRoot, "dist", "media"), { recursive: true });
			writeFileSync(join(packageRoot, "src", "media", `wasmedge${extension}`), "");
			writeFileSync(join(packageRoot, "dist", "media", `wasmedge${extension}`), "");
			expect(staleBuildOutputs(packageRoot)).toEqual([]);

			const stale = join(packageRoot, "dist", "media", `legacy${extension}`);
			writeFileSync(stale, "");

			expect(staleBuildOutputs(packageRoot)).toEqual([stale]);
		},
	);

	/** Everything `npm run build:binary` writes that `npm run build` does not.
	 *
	 *  The release workflow runs the ordinary build and packs that, so none of
	 *  this belongs in a tarball -- and the ordinary build neither replaces nor
	 *  removes any of it, so a workspace that once ran build:binary keeps the
	 *  lot. Giving these rules of their own was what let them through, and what
	 *  they would have carried is not small: the flattened copies, whole docs
	 *  and examples trees, and a compiled binary at dist/pi. */
	it.each([
		"pi",
		"photon_rs_bg.wasm",
		"package.json",
		"README.md",
		"CHANGELOG.md",
		join("theme", "wasmedge.json"),
		join("assets", "splash.png"),
		join("export-html", "template.html"),
		join("export-html", "vendor", "marked.min.js"),
		join("docs", "guide.md"),
		join("examples", "sdk", "demo.ts"),
	])("reports dist/%s, which only the standalone binary build writes", (relativePath) => {
		const packageRoot = packageWithRenamedSource();
		const stale = join(packageRoot, "dist", relativePath);
		mkdirSync(dirname(stale), { recursive: true });
		writeFileSync(stale, "");

		expect(staleBuildOutputs(packageRoot, "coding-agent")).toEqual([stale]);
	});

	/** coding-agent's exemptions, borrowed by packages that cannot earn them.
	 *
	 *  bundle, skills and wasmedge-agent-runtime are steps in one package's
	 *  build. ai, agent and tui are plain tsgo builds with none of them, so a
	 *  file at one of those paths is output nothing there produces -- and it
	 *  passed as generated content in all three. The empty package directory
	 *  stands for one added to releasePackages without a thought here: unknown
	 *  means strict, not lenient. */
	it.each([
		["bundle", "ai"],
		["skills", "agent"],
		["wasmedge-agent-runtime", "tui"],
		["bundle", ""],
	])("treats dist/%s as output the %s package never writes", (generatedTree, packageDir) => {
		const packageRoot = packageWithRenamedSource();
		const stale = join(packageRoot, "dist", generatedTree, "old.js");
		mkdirSync(dirname(stale), { recursive: true });
		writeFileSync(stale, "export const old = '';\n");

		expect(staleBuildOutputs(packageRoot, packageDir)).toEqual([stale]);
		// ...and the exemption still stands for the package that earns it.
		expect(staleBuildOutputs(packageRoot, "coding-agent")).toEqual([]);
	});

	it("leaves coding-agent's generated trees alone", () => {
		// Each has a rule naming the step that writes it, and each is replaced
		// wholesale on every build, so nothing under it can outlive its source.
		// A rule is the only thing that exempts output, so a build step writing
		// somewhere new fails the next release until it gets one.
		const packageRoot = packageWithRenamedSource();
		mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
		writeFileSync(join(packageRoot, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
		mkdirSync(join(packageRoot, "dist", "skills", "refine"), { recursive: true });
		writeFileSync(join(packageRoot, "dist", "skills", "refine", "SKILL.json"), "{}\n");
		mkdirSync(join(packageRoot, "dist", "wasmedge-agent-runtime", "template"), { recursive: true });
		writeFileSync(join(packageRoot, "dist", "wasmedge-agent-runtime", "template", "Cargo.toml"), "\n");

		expect(staleBuildOutputs(packageRoot, "coding-agent")).toEqual([]);
	});

	it("names main, types, every bin target and every exports subpath", () => {
		expect(
			declaredEntryPoints({
				main: "./dist/index.js",
				types: "./dist/index.d.ts",
				bin: { "pi-ai": "./dist/cli.js" },
				exports: {
					".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
					"./mcp": { types: "./dist/mcp.d.ts", import: "./dist/mcp.js" },
				},
			}),
		).toEqual(["dist/cli.js", "dist/index.d.ts", "dist/index.js", "dist/mcp.d.ts", "dist/mcp.js"]);
	});

	it("reads the internal manifests, which promise far more than a dist directory", () => {
		// The AI package is the one this matters most for: a command and a
		// provider subpath each, none of which a dist directory's existence
		// says anything about.
		const aiPackage = JSON.parse(readFileSync(join(repoRoot, "packages", "ai", "package.json"), "utf-8"));
		const entryPoints = declaredEntryPoints(aiPackage);

		expect(entryPoints).toContain("dist/cli.js");
		expect(entryPoints).toContain("dist/providers/anthropic.js");
		expect(entryPoints.length).toBeGreaterThan(20);
	});

	it.each([
		["an empty dist", [] as string[], ["dist/cli.js", "dist/index.d.ts", "dist/index.js"]],
		["a partial build", ["index.js", "index.d.ts"], ["dist/cli.js"]],
	])("reports what %s leaves the manifest unable to deliver", (_name, built, expected) => {
		// A dist directory was the whole requirement for an internal package, so
		// an empty one passed while the manifest went on promising an import
		// path, a declaration file and a command. That tarball installs and then
		// fails on first use, and npm reports it at neither pack nor install
		// time.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-partial-"));
		tempDirs.push(packageRoot);
		mkdirSync(join(packageRoot, "dist"), { recursive: true });
		// The sources behind a complete build, so what the partial one did emit
		// is accounted for and only the gap shows.
		mkdirSync(join(packageRoot, "src"), { recursive: true });
		writeFileSync(join(packageRoot, "src", "index.ts"), "export const index = '';\n");
		writeFileSync(join(packageRoot, "src", "cli.ts"), "export const cli = '';\n");
		for (const file of built) writeFileSync(join(packageRoot, "dist", file), "");
		const manifest = {
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			bin: { "pi-ai": "./dist/cli.js" },
		};

		expect(missingReleaseArtifacts(packageRoot, declaredEntryPoints(manifest))).toEqual(
			expected.map((relativePath) => join(packageRoot, relativePath)),
		);
		// Nothing there is stale: the failure is what is absent, not what is left.
		expect(staleBuildOutputs(packageRoot, "ai")).toEqual([]);
	});

	it("rejects a symbolic link standing where the command target should be", () => {
		// statSync answered for whatever the link pointed at, so the
		// regular-file requirement was met by a fact about the packing machine
		// rather than about the tarball.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-link-bin-"));
		tempDirs.push(packageRoot);
		mkdirSync(join(packageRoot, dirname(PUBLIC_BIN_TARGET)), { recursive: true });
		const real = join(packageRoot, "dist", "bundle", "real.js");
		writeFileSync(real, "#!/usr/bin/env node\n");
		symlinkSync(real, join(packageRoot, PUBLIC_BIN_TARGET));

		expect(missingReleaseArtifacts(packageRoot, [PUBLIC_BIN_TARGET])).toEqual([join(packageRoot, PUBLIC_BIN_TARGET)]);
	});

	it("finds a symbolic link in dist, including under a tree the rules skip", () => {
		// The walk asked isFile() and isDirectory(), and a link answers no to
		// both -- so it was neither collected nor descended into, and no check
		// ever saw it. dist/bundle compounds that: it is generated for
		// coding-agent, so the rules would not have looked either.
		const packageRoot = packageWithRenamedSource();
		expect(symlinkedBuildOutputs(packageRoot)).toEqual([]);

		mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
		const real = join(packageRoot, "dist", "bundle", "real.js");
		writeFileSync(real, "#!/usr/bin/env node\n");
		const link = join(packageRoot, "dist", "bundle", "cli.js");
		symlinkSync(real, link);

		expect(symlinkedBuildOutputs(packageRoot)).toEqual([link]);
		// Reported as a link and nothing else: a rule cannot make one
		// legitimate, so it must not be filed under the error that a rule fixes.
		expect(staleBuildOutputs(packageRoot, "coding-agent")).toEqual([]);
	});

	it("collects a link to a directory without walking into it", () => {
		const packageRoot = packageWithRenamedSource();
		const outside = join(packageRoot, "outside");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "legacy.js"), "export const legacy = '';\n");
		const link = join(packageRoot, "dist", "linked");
		symlinkSync(outside, link);

		expect(symlinkedBuildOutputs(packageRoot)).toEqual([link]);
		expect(staleBuildOutputs(packageRoot, "coding-agent")).toEqual([]);
	});

	it("reports an implementation module that a declared entry point imports", () => {
		// A build that stopped part way. Checking the manifest's entry points
		// answers for index.js and its declaration and nothing else, and the
		// stale check answers the other question entirely -- whether what is
		// there still has a source. Between them, the module index.js reaches
		// for at run time was nobody's business.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-half-built-"));
		tempDirs.push(packageRoot);
		mkdirSync(join(packageRoot, "src"), { recursive: true });
		mkdirSync(join(packageRoot, "dist"), { recursive: true });
		writeFileSync(join(packageRoot, "src", "index.ts"), 'export * from "./worker.js";\n');
		writeFileSync(join(packageRoot, "src", "worker.ts"), "export const worker = '';\n");
		for (const output of ["index.js", "index.d.ts", "index.js.map", "index.d.ts.map"]) {
			writeFileSync(join(packageRoot, "dist", output), "");
		}
		const manifest = { main: "./dist/index.js", types: "./dist/index.d.ts" };

		// Everything the manifest names is there...
		expect(missingReleaseArtifacts(packageRoot, declaredEntryPoints(manifest))).toEqual([]);
		// ...and nothing in dist is stale, because what is there has a source.
		expect(staleBuildOutputs(packageRoot)).toEqual([]);

		expect(missingSourceOutputs(packageRoot)).toEqual([
			join(packageRoot, "dist", "worker.d.ts"),
			join(packageRoot, "dist", "worker.d.ts.map"),
			join(packageRoot, "dist", "worker.js"),
			join(packageRoot, "dist", "worker.js.map"),
		]);
	});

	it("owes an output for every source, in every directory, and none for a declaration", () => {
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-owed-"));
		tempDirs.push(packageRoot);
		mkdirSync(join(packageRoot, "src", "core"), { recursive: true });
		mkdirSync(join(packageRoot, "dist", "core"), { recursive: true });
		writeFileSync(join(packageRoot, "src", "index.ts"), "export const index = '';\n");
		writeFileSync(join(packageRoot, "src", "core", "worker.ts"), "export const worker = '';\n");
		// A hand-written declaration is a source that compiles to nothing, and
		// tsconfig.build.json excludes it. Asking dist for its output would fail
		// every build.
		writeFileSync(join(packageRoot, "src", "core", "shims.d.ts"), "declare const shim: string;\n");
		// A copied asset is not owed either: which of them a build copies
		// depends on the glob a step names, and that is checked the other way
		// round, where a copy whose source is gone is stale.
		writeFileSync(join(packageRoot, "src", "core", "theme.json"), "{}\n");
		writeFileSync(join(packageRoot, "dist", "core", "theme.json"), "{}\n");
		for (const base of ["index", "core/worker"]) {
			for (const suffix of [".js", ".d.ts", ".js.map", ".d.ts.map"]) {
				writeFileSync(join(packageRoot, "dist", ...`${base}${suffix}`.split("/")), "");
			}
		}

		expect(missingSourceOutputs(packageRoot)).toEqual([]);
	});

	it.each([".js", ".d.ts", ".js.map", ".d.ts.map"])("requires the %s a TypeScript source emits", (suffix) => {
		// tsconfig.base.json turns on declaration, declarationMap and sourceMap,
		// so all four are build output. The maps are not decoration: the emitted
		// .js and .d.ts each carry a sourceMappingURL comment naming one, and a
		// package that ships without them ships a dangling reference.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-emits-"));
		tempDirs.push(packageRoot);
		mkdirSync(join(packageRoot, "src"), { recursive: true });
		mkdirSync(join(packageRoot, "dist"), { recursive: true });
		writeFileSync(join(packageRoot, "src", "index.ts"), "export const index = '';\n");
		for (const emitted of [".js", ".d.ts", ".js.map", ".d.ts.map"]) {
			if (emitted !== suffix) writeFileSync(join(packageRoot, "dist", `index${emitted}`), "");
		}

		expect(missingSourceOutputs(packageRoot)).toEqual([join(packageRoot, "dist", `index${suffix}`)]);
	});

	it.each([
		join("modes", "interactive", "theme", "wasmedge.json"),
		join("modes", "interactive", "assets", "splash.png"),
		join("core", "export-html", "template.html"),
		join("core", "export-html", "vendor", "marked.min.js"),
	])("requires the copy of the source asset src/%s", (relativePath) => {
		// copy-assets names each directory it copies, but the fact underneath is
		// simpler: every non-TypeScript source in src is copied into dist under
		// the same relative path. Asking for that needs no globs here, and a
		// glob copied into this file is a second copy of the build script to
		// keep in step.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-asset-"));
		tempDirs.push(packageRoot);
		const source = join(packageRoot, "src", relativePath);
		mkdirSync(dirname(source), { recursive: true });
		mkdirSync(join(packageRoot, "dist"), { recursive: true });
		writeFileSync(source, "");

		expect(missingSourceOutputs(packageRoot)).toEqual([join(packageRoot, "dist", relativePath)]);
	});

	it("leaves an unbuilt package to the check that names the remedy", () => {
		// missingReleaseArtifacts reports the absent dist and says to build.
		// Answering again with every output the sources owe would bury it.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-unbuilt-src-"));
		tempDirs.push(packageRoot);
		mkdirSync(join(packageRoot, "src"), { recursive: true });
		writeFileSync(join(packageRoot, "src", "index.ts"), "export const index = '';\n");

		expect(missingSourceOutputs(packageRoot)).toEqual([]);
		expect(missingReleaseArtifacts(packageRoot)).toEqual([join(packageRoot, "dist")]);
	});

	it("says nothing about a package that was never built", () => {
		// missingReleaseArtifacts owns that failure and names the remedy. Two
		// errors for one cause would only bury it.
		const packageRoot = mkdtempSync(join(tmpdir(), "wasmedge-agent-unbuilt-"));
		tempDirs.push(packageRoot);
		mkdirSync(join(packageRoot, "src"), { recursive: true });

		expect(staleBuildOutputs(packageRoot)).toEqual([]);
	});

	it("records the host the release is published to, so an install can find its own updates", () => {
		// The workflow knows the bucket, packs with it and renders it into the
		// installer -- and the installed CLI kept none of it, so the update
		// check silently did not run and `update` failed with "No release host
		// is configured" until the user exported the variable by hand, for
		// every invocation.
		const manifest = releaseManifest("wasmedge-agent", "https://releases.example.test/");
		const piConfig = manifest.piConfig as Record<string, unknown>;

		expect(piConfig.downloadBaseUrl).toBe("https://releases.example.test/");
	});

	it("reads that host back under the name config.ts looks for", () => {
		// Two files, one field name, and a mismatch is silent: the manifest
		// carries a host nothing reads, and the CLI goes on behaving like a
		// source checkout. Pinned by reading the source rather than by
		// importing it, because config.ts resolves the value at module load
		// from this repository's own package.json, which has no such field.
		const configSource = readFileSync(join(repoRoot, "packages", "coding-agent", "src", "config.ts"), "utf-8");

		expect(configSource).toContain("pkg.piConfig?.downloadBaseUrl");
	});

	it("leaves the internal workspace packages without a release host", () => {
		// Only the public package installs a command that can update itself.
		for (const packageName of ["wasmedge-agent-ai", "wasmedge-agent-core", "wasmedge-agent-tui"]) {
			const piConfig = releaseManifest(packageName, "https://releases.example.test/").piConfig as
				| Record<string, unknown>
				| undefined;
			expect(piConfig?.downloadBaseUrl).toBeUndefined();
		}
	});

	it("records nothing when the packer was given no host", () => {
		// The covering tests above call the packer directly; main() cannot,
		// because parseArgs refuses to run without --base-url.
		const piConfig = releaseManifest("wasmedge-agent").piConfig as Record<string, unknown>;

		expect(piConfig.downloadBaseUrl).toBeUndefined();
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
