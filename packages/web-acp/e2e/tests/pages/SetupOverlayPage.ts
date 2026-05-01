import type { Page, Locator } from '@playwright/test';

export class SetupOverlayPage {
  readonly overlay: Locator;
  readonly iframe: ReturnType<Page['frameLocator']>;

  constructor(private page: Page) {
    this.overlay = page.locator('[data-testid="div-setup-overlay-v2"]');
    this.iframe = page.frameLocator('[data-testid="iframe-setup-v2"]');
  }

  async walkIfPresent(bodhiServerUrl: string): Promise<void> {
    if (!(await this.overlay.isVisible().catch(() => false))) return;
    await this.page.locator('[data-testid="iframe-setup-v2"]').waitFor({ state: 'attached' });
    await this.iframe.getByTestId('div-setup-screen').waitFor();
    await this.iframe.getByTestId('input-server-url').fill(bodhiServerUrl);
    await this.iframe.getByTestId('btn-connect').click();
    await this.iframe
      .getByTestId('text-probe-status-message')
      .filter({ hasText: 'Server is connected' })
      .waitFor();
    await this.iframe.getByTestId('btn-continue').click();
    await this.overlay.waitFor({ state: 'hidden' });
  }
}
