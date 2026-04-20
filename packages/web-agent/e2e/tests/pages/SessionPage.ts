import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Page object for the session picker (M5).
 *
 * Stays strictly UI-driven — the picker's own data-testids are the only
 * seam. No `page.evaluate` reaching into the SessionManager or Worker
 * internals; whatever the product surfaces is what the spec asserts on.
 */
export class SessionPage {
  readonly root: Locator;
  readonly trigger: Locator;
  readonly list: Locator;
  readonly newButton: Locator;
  readonly renameInput: Locator;
  readonly renameSubmit: Locator;
  readonly renameTrigger: Locator;

  constructor(private readonly page: Page) {
    this.root = page.locator('[data-testid="session-picker"]');
    this.trigger = page.locator('[data-testid="session-picker-trigger"]');
    this.list = page.locator('[data-testid="session-picker-list"]');
    this.newButton = page.locator('[data-testid="session-new"]');
    this.renameInput = page.locator('[data-testid="session-rename"]');
    this.renameSubmit = page.locator('[data-testid="session-rename-submit"]');
    this.renameTrigger = page.locator('[data-testid="session-rename-trigger"]');
  }

  listItem(sessionId: string): Locator {
    return this.page.locator(`[data-testid="session-list-item"][data-path="${sessionId}"]`);
  }

  deleteButton(sessionId: string): Locator {
    return this.page.locator(`[data-testid="session-delete-${sessionId}"]`);
  }

  /** Wait until a persisted session is active (localStorage id restored). */
  async waitForActiveSession(timeoutMs = 15_000): Promise<string> {
    await expect(this.root).toBeVisible({ timeout: timeoutMs });
    await expect
      .poll(
        async () => {
          const id = await this.root.getAttribute('data-active-session-id');
          return id && id.length > 0 ? id : null;
        },
        { timeout: timeoutMs }
      )
      .not.toBeNull();
    const id = await this.root.getAttribute('data-active-session-id');
    if (!id) throw new Error('session id never populated');
    return id;
  }

  async currentSessionId(): Promise<string | null> {
    return this.root.getAttribute('data-active-session-id');
  }

  async open(): Promise<void> {
    await this.trigger.click();
    await expect(this.list).toBeVisible();
  }

  async newSession(): Promise<void> {
    await this.open();
    await this.newButton.click();
    await expect(this.list).not.toBeVisible();
  }

  async switchTo(sessionId: string): Promise<void> {
    await this.open();
    await this.listItem(sessionId).click();
    await expect(this.list).not.toBeVisible();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.open();
    await this.deleteButton(sessionId).click();
  }

  async rename(name: string): Promise<void> {
    await this.renameTrigger.click();
    await this.renameInput.fill(name);
    await this.renameSubmit.click();
  }
}
