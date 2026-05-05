import { expect, type Locator, type Page } from '@playwright/test';

export type McpServerState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * POM for acp-ui's `McpPanel.vue`. Mirrors web-acp's
 * `McpPanelComponent.ts` shape — reads connection state via
 * `data-test-state` on the per-server row, asserts visibility of
 * tools that the agent's `_bodhi/mcp/state` notification advertised.
 */
export class McpPanelComponent {
  readonly panel: Locator;

  constructor(private page: Page) {
    this.panel = page.locator('[data-testid="mcp-panel"]');
  }

  server(slug: string): Locator {
    return this.page.locator(`[data-testid="mcp-server-${slug}"]`);
  }

  tool(slug: string, name: string): Locator {
    return this.page.locator(`[data-testid="mcp-tool-${slug}-${name}"]`);
  }

  async expectServerState(slug: string, state: McpServerState): Promise<void> {
    await expect(this.server(slug)).toHaveAttribute('data-test-state', state);
  }

  async expectToolVisible(slug: string, name: string): Promise<void> {
    await expect(this.tool(slug, name)).toBeVisible();
  }

  async expectAbsent(slug: string): Promise<void> {
    await expect(this.server(slug)).toHaveCount(0);
  }
}
