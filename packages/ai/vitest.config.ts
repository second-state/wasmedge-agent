import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolved against this file, not against `root`: Vitest resolves a relative
// setupFiles entry from the cwd, so a bare './test/...' misses on any run
// started somewhere other than this package — and a missing setup file fails
// every test file in the project, not just one.
const providerEnvSetup = fileURLToPath(new URL('./test/setup-provider-env.ts', import.meta.url));
const providerEnvGlobalSetup = fileURLToPath(new URL('./test/global-setup-provider-env.ts', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for API calls
    // Scrub inherited provider credentials before any test module loads, so
    // the live E2E suites stay opt-in instead of switching on for whichever
    // keys the developer happens to have exported. CI sets no provider
    // secrets, so this only makes local runs match what CI already does.
    setupFiles: [providerEnvSetup],
    // Reports the scrub once per run; the scrub itself stays in setupFiles.
    globalSetup: [providerEnvGlobalSetup],
  }
});