/**
 * Dev-only InMemory vault seed reader (main-thread side).
 *
 * After M4 the actual InMemory ZenFS backend lives inside the agent
 * Worker — `WorkerAgentHost.mountDevSeed(seed)` constructs and seeds it
 * over there. This module's only job on main is to read the seed object
 * Playwright stashed on `window.__zenfsSeed` and expose it to the boot
 * code so the Worker init message can carry it.
 *
 * Test-only. Loaded via `import.meta.env.DEV`-gated dynamic import so it
 * tree-shakes out of production bundles.
 */

export interface InMemoryVaultSeed {
  /** Absolute paths rooted at `/vault`, mapped to file contents (UTF-8 text). */
  files: Record<string, string>;
  /** Display name for the synthetic vault (used as the root directory label). */
  name: string;
}

/**
 * Read the dev-mode seed from `window.__zenfsSeed`. Returns `undefined`
 * when not in dev mode or no seed is present.
 */
export function readDevSeed(): InMemoryVaultSeed | undefined {
  if (typeof window === 'undefined') return undefined;
  const seed = (window as unknown as { __zenfsSeed?: InMemoryVaultSeed }).__zenfsSeed;
  return seed;
}
