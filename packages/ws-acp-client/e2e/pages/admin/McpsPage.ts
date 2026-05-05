import { expect, Page } from '@playwright/test';

/**
 * Minimal TypeScript port of the Bodhi MCP management page object used
 * by `BodhiApp/crates/lib_bodhiserver/tests-js/pages/McpsPage.mjs`.
 * Mirrors `packages/web-acp/e2e/tests/pages/admin/McpsPage.ts`.
 *
 * We only port the paths ws-acp-client's global-setup needs:
 *
 * 1. `createMcpServer(url, name, description)` — creates an MCP server
 *    record on the Bodhi side pointing at a Streamable-HTTP upstream.
 * 2. `createMcpInstance(serverName, name, slug, description)` —
 *    creates a public (no auth config) instance bound to that server.
 *
 * Everything auth-config / OAuth related is deliberately out of scope
 * here. Phase 10 only exercises the public "everything" server, so the
 * new-instance form just selects "Public" from the auth dropdown.
 */
export class McpsPage {
  constructor(
    private page: Page,
    private serverUrl: string
  ) {}

  selectors = {
    serversPage: '[data-testid="mcp-servers-page"]',
    newServerPage: '[data-testid="new-mcp-server-page"]',
    serverNewButton: '[data-testid="mcp-server-new-button"]',
    serverUrlInput: '[data-testid="mcp-server-url-input"]',
    serverNameInput: '[data-testid="mcp-server-name-input"]',
    serverDescriptionInput: '[data-testid="mcp-server-description-input"]',
    serverSaveButton: '[data-testid="mcp-server-save-button"]',
    serverRowByName: (name: string) => `[data-test-server-name="${name}"]`,

    mcpsPage: '[data-testid="mcps-page"]',
    newMcpPage: '[data-testid="new-mcp-page"]',
    newButton: '[data-testid="mcp-new-button"]',
    serverCombobox: '[data-testid="mcp-server-combobox"]',
    serverSearch: '[data-testid="mcp-server-search"]',
    nameInput: '[data-testid="mcp-name-input"]',
    slugInput: '[data-testid="mcp-slug-input"]',
    descriptionInput: '[data-testid="mcp-description-input"]',
    createButton: '[data-testid="mcp-create-button"]',
    mcpRowByName: (name: string) => `[data-test-mcp-name="${name}"]`,

    authConfigSelect: '[data-testid="auth-config-select"]',
    authConfigOptionPublic: '[data-testid="auth-config-option-public"]',
  };

  private async navigate(path: string): Promise<void> {
    await this.page.goto(`${this.serverUrl}${path}`);
    await this.page.waitForLoadState('domcontentloaded');
  }

  async navigateToServersList(): Promise<void> {
    await this.navigate('/ui/mcps/servers/');
    await this.page.waitForURL(/\/ui\/mcps\/servers/);
  }

  async createMcpServer(url: string, name: string, description = ''): Promise<void> {
    await this.navigateToServersList();
    await this.page.click(this.selectors.serverNewButton);
    await this.page.waitForURL(/\/ui\/mcps\/servers\/new/);
    await expect(this.page.locator(this.selectors.newServerPage)).toBeVisible();

    await this.page.fill(this.selectors.serverNameInput, name);
    await this.page.fill(this.selectors.serverUrlInput, url);
    if (description) {
      await this.page.fill(this.selectors.serverDescriptionInput, description);
    }

    await this.page.click(this.selectors.serverSaveButton);
    await this.page.waitForURL(/\/ui\/mcps\/servers(?!\/new)/);
    await this.page.locator(this.selectors.serverRowByName(name)).first().waitFor();
  }

  async navigateToMcpsList(): Promise<void> {
    await this.navigate('/ui/mcps/');
    await this.page.waitForURL(/\/ui\/mcps(?:\/)?$/);
  }

  async createMcpInstance(
    serverName: string,
    name: string,
    slug: string,
    description = ''
  ): Promise<void> {
    await this.navigateToMcpsList();
    await this.page.click(this.selectors.newButton);
    await this.page.waitForURL(/\/ui\/mcps\/new/);
    await expect(this.page.locator(this.selectors.newMcpPage)).toBeVisible();

    await this.page.click(this.selectors.serverCombobox);
    const searchInput = this.page.locator(this.selectors.serverSearch);
    await expect(searchInput).toBeVisible();
    await searchInput.fill(serverName);
    const option = this.page.locator('[cmdk-item]').filter({ hasText: serverName }).first();
    await expect(option).toBeVisible();
    await option.click();

    if (name) await this.page.fill(this.selectors.nameInput, name);
    await this.page.fill(this.selectors.slugInput, slug);
    if (description) {
      await this.page.fill(this.selectors.descriptionInput, description);
    }

    await this.page.click(this.selectors.authConfigSelect);
    await this.page.locator(this.selectors.authConfigOptionPublic).click();

    await this.page.click(this.selectors.createButton);
    await this.page.waitForURL(/\/ui\/mcps(?!\/new)/);
    await this.page.locator(this.selectors.mcpRowByName(name)).first().waitFor();
  }
}
