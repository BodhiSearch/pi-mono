import { expect, type Page, type Locator } from '@playwright/test';

export class StatusBar {
  readonly appTitle: Locator;
  readonly clientReady: Locator;
  readonly serverReady: Locator;
  readonly authSection: Locator;

  constructor(page: Page) {
    this.appTitle = page.locator('[data-testid="app-title"]');
    this.clientReady = page.locator('[data-testid="badge-client-status"]');
    this.serverReady = page.locator('[data-testid="badge-server-status"]');
    this.authSection = page.locator('[data-testid="section-auth"]');
  }

  async waitReady(): Promise<void> {
    await this.appTitle.waitFor();
    await expect(this.clientReady).toHaveAttribute('data-test-state', 'ready');
    await expect(this.serverReady).toHaveAttribute('data-test-state', 'ready');
  }

  async expectAuthenticated(): Promise<void> {
    await expect(this.authSection).toHaveAttribute('data-test-state', 'authenticated');
  }

  async expectUnauthenticated(): Promise<void> {
    await expect(this.authSection).toHaveAttribute('data-test-state', 'unauthenticated');
  }
}
