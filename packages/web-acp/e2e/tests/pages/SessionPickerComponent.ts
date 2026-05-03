import { expect, type Page, type Locator } from '@playwright/test';

export class SessionPickerComponent {
  readonly picker: Locator;

  constructor(private page: Page) {
    this.picker = page.locator('[data-testid="session-picker"]');
  }

  row(id: string): Locator {
    return this.page.locator(`[data-testid="session-row-${id}"]`);
  }

  deleteButton(id: string): Locator {
    return this.page.locator(`[data-testid="session-delete-${id}"]`);
  }

  async waitForCount(expected: number): Promise<void> {
    await expect(this.picker).toHaveAttribute('data-test-state', String(expected));
  }

  async listIds(): Promise<string[]> {
    return this.page
      .locator('[data-testid="session-picker"] [data-sessionid]')
      .evaluateAll(els => els.map(el => el.getAttribute('data-sessionid') ?? ''));
  }

  async getTitle(id: string): Promise<string> {
    return (await this.row(id).textContent())?.trim() ?? '';
  }

  async click(id: string): Promise<void> {
    await this.row(id).click();
    await expect(this.row(id)).toHaveAttribute('data-test-state', 'active');
  }

  async expectActive(id: string): Promise<void> {
    await expect(this.row(id)).toHaveAttribute('data-test-state', 'active');
  }

  async delete(id: string): Promise<void> {
    // The trash icon is hover-revealed (`group-hover:opacity-100`); the
    // wrapping <li> carries the `group` class. Hover the row to make the
    // delete button visible before clicking.
    await this.row(id).hover();
    await this.deleteButton(id).click();
  }

  async waitAbsent(id: string): Promise<void> {
    await this.row(id).waitFor({ state: 'detached' });
  }
}
