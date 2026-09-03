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

export declare function createReleasePackageJson(
	sourcePackage: Record<string, unknown>,
	packageName: string,
	releaseVersion: string,
	internalPackageUrls: Map<string, string>,
): Record<string, unknown>;
