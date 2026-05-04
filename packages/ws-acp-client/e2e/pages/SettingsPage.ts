import { expect, type Locator, type Page } from '@playwright/test';

// POM for acp-ui's settings dialog. Currently surfaces only the Bodhi
// server URL panel; future phases extend this with the agent-add form
// and other panels.
export class SettingsPage {
  readonly openButton: Locator;
  readonly closeButton: Locator;
  readonly dialog: Locator;
  readonly bodhiSection: Locator;
  readonly bodhiServerUrlInput: Locator;
  readonly bodhiServerSaveButton: Locator;
  readonly bodhiServerCurrent: Locator;
  readonly bodhiServerError: Locator;
  readonly bodhiServerSaved: Locator;

  constructor(private page: Page) {
    this.openButton = page.locator('[data-testid="btn-settings"]');
    this.closeButton = page.locator('[data-testid="btn-settings-close"]');
    this.dialog = page.locator('[data-testid="dialog-settings"]');
    this.bodhiSection = page.locator('[data-testid="section-bodhi-server"]');
    this.bodhiServerUrlInput = page.locator('[data-testid="input-bodhi-server-url"]');
    this.bodhiServerSaveButton = page.locator('[data-testid="btn-bodhi-server-save"]');
    this.bodhiServerCurrent = page.locator('[data-testid="text-bodhi-server-current"]');
    this.bodhiServerError = page.locator('[data-testid="text-bodhi-server-error"]');
    this.bodhiServerSaved = page.locator('[data-testid="text-bodhi-server-saved"]');
  }

  async open(): Promise<void> {
    await this.openButton.click();
    await expect(this.dialog).toBeVisible();
  }

  async close(): Promise<void> {
    await this.closeButton.click();
    await expect(this.dialog).toBeHidden();
  }

  async setBodhiServerUrl(url: string): Promise<void> {
    await this.bodhiServerUrlInput.fill(url);
    await this.bodhiServerSaveButton.click();
    // Save should resolve to either the saved notice or an error notice.
    // We don't fail here on errors — the caller can inspect the section
    // state via `bodhiServerStatus()` and assert as appropriate.
    await expect(this.bodhiSection).toHaveAttribute(
      'data-test-state',
      /(configured|error)/
    );
  }

  async bodhiServerStatus(): Promise<string | null> {
    return this.bodhiSection.getAttribute('data-test-state');
  }
}
