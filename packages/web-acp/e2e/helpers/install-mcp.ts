import type { Page } from '@playwright/test';

/**
 * installMcpEverythingUrl — writes `window.__mcpEverythingUrl` on
 * every navigation so `Header.tsx` → `resolveEverythingMcpUrl()` can
 * pick it up before the user clicks login. The URL points at the
 * Streamable-HTTP reference MCP server spun up by `global-setup.ts`.
 *
 * Mirrors `install-volumes.ts`: pure main-thread init hook, no worker
 * plumbing, safe to run before the first `page.goto`.
 */
export async function installMcpEverythingUrl(page: Page, url: string): Promise<void> {
  await page.addInitScript(value => {
    (window as unknown as { __mcpEverythingUrl: string }).__mcpEverythingUrl = value;
  }, url);
}
