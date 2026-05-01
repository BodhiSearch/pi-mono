import { expect, type Page, type Locator } from '@playwright/test';

export type McpServerState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type ToggleState = 'on' | 'off';

export class McpPanelComponent {
  readonly panel: Locator;
  readonly emptyState: Locator;

  constructor(private page: Page) {
    this.panel = page.locator('[data-testid="mcp-panel"]');
    this.emptyState = page.locator('[data-testid="mcp-panel-empty"]');
  }

  server(slug: string): Locator {
    return this.page.locator(`[data-testid="mcp-server-${slug}"]`);
  }

  tool(slug: string, name: string): Locator {
    return this.page.locator(`[data-testid="mcp-tool-${slug}-${name}"]`);
  }

  serverToggle(slug: string): Locator {
    return this.page.locator(`[data-testid="mcp-session-server-${slug}"]`);
  }

  toolToggle(slug: string, name: string): Locator {
    return this.page.locator(`[data-testid="mcp-session-tool-${slug}-${name}"]`);
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

  async expectServerToggle(slug: string, state: ToggleState): Promise<void> {
    await expect(this.serverToggle(slug)).toHaveAttribute('data-test-state', state);
  }

  async expectToolToggle(
    slug: string,
    name: string,
    state: ToggleState,
    opts: { timeout?: number } = {}
  ): Promise<void> {
    await expect(this.toolToggle(slug, name)).toHaveAttribute('data-test-state', state, opts);
  }

  async setServer(slug: string, desired: ToggleState): Promise<void> {
    const current = await this.serverToggle(slug).getAttribute('data-test-state');
    if (current === desired) return;
    await this.serverToggle(slug).locator('input[type="checkbox"]').click();
    await this.expectServerToggle(slug, desired);
  }

  async setTool(slug: string, name: string, desired: ToggleState): Promise<void> {
    const current = await this.toolToggle(slug, name).getAttribute('data-test-state');
    if (current === desired) return;
    await this.toolToggle(slug, name).locator('input[type="checkbox"]').click();
    await this.expectToolToggle(slug, name, desired);
  }
}
