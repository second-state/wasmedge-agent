// Types for the parts the covering test imports. The packer itself is plain
// JavaScript and stays that way; this declares only what crosses into
// TypeScript, so the test can assert the generated manifest's shape and the
// build check that guards it.

/** What the canonical command in the published bin map points at. */
export declare const PUBLIC_BIN_TARGET: string;

/** What the deprecated command alias points at: its own entry point, so the
 *  invoked identity survives a launcher that does not preserve argv[1]. */
export declare const PUBLIC_LEGACY_BIN_TARGET: string;

/** Writes the alias entry point into a staged package root, returning its
 *  absolute path. */
export declare function writeLegacyAliasShim(packageRoot: string): string;

/** Build outputs missing from a package root, as absolute paths. Empty means
 *  the package is ready to pack. */
export declare function missingReleaseArtifacts(packageRoot: string, requiredFiles?: readonly string[]): string[];

/** Every file a published manifest points a consumer at, as package-relative
 *  paths, sorted: main, types, each bin target, and every string leaf under
 *  exports. A dist directory's existence says nothing about any of them. */
export declare function declaredEntryPoints(packageJson: Record<string, unknown>): string[];

/** Build outputs in the package's dist that its release build does not account
 *  for, as absolute paths, sorted. `packageDir` is the workspace directory
 *  whose rules apply; omitting it checks against the compiled src mapping
 *  alone, which is the strict reading. */
export declare function staleBuildOutputs(packageRoot: string, packageDir?: string): string[];

/** Outputs the package's sources owe dist but did not produce, as absolute
 *  paths, sorted. A TypeScript source owes a .js, a .d.ts and both map files;
 *  a .d.ts source owes nothing; every other source is copied under its own
 *  name and owes itself. Empty when the package is unbuilt: that is
 *  missingReleaseArtifacts' to report. */
export declare function missingSourceOutputs(packageRoot: string): string[];

/** Symbolic links anywhere in the package's dist, as absolute paths, sorted.
 *  No build step writes one, so what a link resolves to is a property of the
 *  machine that packed it rather than of the package. */
export declare function symlinkedBuildOutputs(packageRoot: string): string[];

/** Where a release's files sit under the host, as one relative path. Both the
 *  URLs baked into the published package manifests and the path recorded in
 *  release.json come from here. */
export declare function releaseAssetPath(version: string, file: string): string;

/** `releaseAssetPath`, joined onto a release host's base URL. */
export declare function releaseAssetUrl(baseUrl: string, version: string, file: string): string;

export declare function createReleasePackageJson(
	sourcePackage: Record<string, unknown>,
	packageName: string,
	releaseVersion: string,
	internalPackageUrls: Map<string, string>,
	/** Recorded in the public package's piConfig, so an installed release knows
	 *  the host it came from and can check for its own updates. */
	downloadBaseUrl?: string,
): Record<string, unknown>;
