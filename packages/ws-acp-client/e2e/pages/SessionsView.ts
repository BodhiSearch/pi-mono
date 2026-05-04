import { expect, type Locator, type Page } from '@playwright/test';

// POM for the "Saved Sessions" sidebar section.
//
// State is fully expressed via data-testid attributes:
//   - `section-sessions` is the container
//   - `list-sessions` carries `data-test-count` (decimal)
//   - each row is `row-session-{id}` with `data-test-agent` /
//     `data-test-title`
//   - the per-row delete button is `btn-session-delete-{id}`
//
// `id` here is the locally-generated UUID acp-ui assigns; tests
// typically don't know the id ahead of time, so `rowByTitle` is the
// usual entry point.
export class SessionsView {
  readonly section: Locator;
  readonly list: Locator;
  readonly empty: Locator;

  constructor(private page: Page) {
    this.section = page.locator('[data-testid="section-sessions"]');
    this.list = page.locator('[data-testid="list-sessions"]');
    this.empty = page.locator('[data-testid="text-sessions-empty"]');
  }

  /** All currently-rendered session rows, in DOM order. */
  rows(): Locator {
    return this.page.locator('[data-testid^="row-session-"]');
  }

  /** Row with `data-test-title` exactly equal to `title`. */
  rowByTitle(title: string): Locator {
    return this.page.locator(`[data-testid^="row-session-"][data-test-title="${title}"]`);
  }

  async expectCount(n: number): Promise<void> {
    if (n === 0) {
      await expect(this.empty).toBeVisible();
      return;
    }
    await expect(this.list).toHaveAttribute('data-test-count', String(n));
  }

  async openByTitle(title: string): Promise<void> {
    await this.rowByTitle(title).click();
  }

  /** Click a row's delete button. The host uses `window.confirm` for
   * the destructive guard — the caller is responsible for accepting
   * that dialog (e.g. via `page.once('dialog', d => d.accept())`). */
  async deleteByTitle(title: string): Promise<void> {
    const row = this.rowByTitle(title);
    const id = (await row.getAttribute('data-testid'))?.replace('row-session-', '');
    if (!id) {
      throw new Error(`Could not resolve session id from row data-testid for title="${title}"`);
    }
    await this.page.locator(`[data-testid="btn-session-delete-${id}"]`).click();
  }
}
