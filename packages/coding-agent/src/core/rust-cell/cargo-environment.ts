const ALLOWED = new Set([
	"PATH",
	"HOME",
	"USERPROFILE",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"PATHEXT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"SDKROOT",
	"MACOSX_DEPLOYMENT_TARGET",
	"CARGO_HOME",
	"CARGO_NET_OFFLINE",
	"RUSTUP_HOME",
	"RUSTUP_TOOLCHAIN",
	"RUSTUP_AUTO_INSTALL",
	"RUSTC",
]);
const WINDOWS_ALLOWED = new Set([...ALLOWED].map((name) => name.toUpperCase()));

/** Cargo passes its environment to rustc and host build scripts. Inherit only
 * toolchain/system configuration, never the worker's ambient credentials.
 * This does not sandbox compilation or restrict Cargo configuration files. */
export function cargoEnvironment(
	source: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(source).filter(
			([name, value]) =>
				value !== undefined && (platform === "win32" ? WINDOWS_ALLOWED.has(name.toUpperCase()) : ALLOWED.has(name)),
		),
	);
}
