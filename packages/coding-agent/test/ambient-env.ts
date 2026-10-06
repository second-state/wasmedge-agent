/**
 * Ambient environment sanitation for tests.
 *
 * A running WasmEdge Agent session exports its own runtime configuration into every
 * shell it spawns. A developer who runs the test suite from inside such a session
 * therefore inherits variables that silently change product behaviour: version
 * checks short-circuit or query another release host. CI runs with a clean
 * environment, so suites that cover those code paths pass in CI and fail locally
 * for no visible reason.
 *
 * Tests that exercise update or version-check behaviour must own these variables
 * explicitly instead of inheriting whatever the host shell happens to export.
 */

/**
 * Every variable read by the version-check code path.
 * Keep this in sync with `src/utils/version-check.ts`.
 */
export const AMBIENT_RUNTIME_ENV_VARS: readonly string[] = [
	"PI_OFFLINE",
	"PI_SKIP_VERSION_CHECK",
	"WASMEDGE_AGENT_DOWNLOAD_BASE_URL",
];

/**
 * Removes the ambient variables from this process and returns a callback that puts
 * the original values back. Call it from `beforeEach` and invoke the callback from
 * `afterEach` so each test starts from a known environment.
 */
export function clearAmbientRuntimeEnv(): () => void {
	const saved = new Map<string, string | undefined>();
	for (const name of AMBIENT_RUNTIME_ENV_VARS) {
		saved.set(name, process.env[name]);
		delete process.env[name];
	}
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}
