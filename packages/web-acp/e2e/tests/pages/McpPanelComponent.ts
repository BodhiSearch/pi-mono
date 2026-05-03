import { expect, type Page, type Locator } from '@playwright/test';

export type McpServerState = 'disconnected' | 'connecting' | 'connected' | 'error';

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

  async expectServerState(
    slug: string,
    state: McpServerState,
    opts: { timeout?: number } = {}
  ): Promise<void> {
    await expect(this.server(slug)).toHaveAttribute('data-test-state', state, opts);
  }

  async expectToolVisible(slug: string, name: string): Promise<void> {
    await expect(this.tool(slug, name)).toBeVisible();
  }

  async expectAbsent(slug: string): Promise<void> {
    await expect(this.server(slug)).toHaveCount(0);
  }
}
