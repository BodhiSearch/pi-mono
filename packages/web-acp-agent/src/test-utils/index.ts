/**
 * Public test-utils for `@bodhiapp/web-acp-agent` consumers. Exposed
 * via the `./test-utils` package export so host runtimes (browser,
 * CLI, future HTTP host) can re-use the volume-seed helpers in their
 * own test suites without depending on agent-internal paths.
 *
 * The vitest setup script (`setup.ts`) is intentionally **not**
 * re-exported here — it's loaded via `vitest.config.ts:setupFiles`,
 * not via `import`.
 */
export type { SeedSpec } from './seed-volume';
export { buildSeedInit } from './seed-volume';
