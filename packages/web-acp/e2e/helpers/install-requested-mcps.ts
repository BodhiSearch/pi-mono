import type { Page } from '@playwright/test';

/**
 * installRequestedMcps — seeds the persisted requested-MCPs IDB list
 * via `window.__mcpRequestedSeed`. The DEV-only boot hook in
 * `useAcp` reads the seed before any login click and writes it
 * straight into IDB so `Header.tsx` → `loadRequestedMcps()` returns
 * the same list as production code would after a `/mcp add` cycle.
 *
 * Mirrors `installVolumes`: pure main-thread init hook, no worker
 * plumbing, must run before the first `page.goto`.
 *
 * Replaces the older `installMcpEverythingUrl` seam — the login click
 * handler no longer reads `window.__mcpEverythingUrl`; it reads the
 * IDB list, which this helper populates.
 */
export async function installRequestedMcps(page: Page, urls: string[]): Promise<void> {
  await page.addInitScript(seed => {
    (window as unknown as { __mcpRequestedSeed?: string[] }).__mcpRequestedSeed = seed;
  }, urls);
}
