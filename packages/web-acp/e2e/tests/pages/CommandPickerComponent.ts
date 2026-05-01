import { expect, type Page, type Locator } from '@playwright/test';

export class CommandPickerComponent {
  readonly picker: Locator;
  readonly emptyState: Locator;

  constructor(private page: Page) {
    this.picker = page.locator('[data-testid="command-picker"]');
    this.emptyState = page.locator('[data-testid="command-picker-empty"]');
  }

  item(name: string): Locator {
    return this.page.locator(`[data-testid="command-picker-item-${name}"]`);
  }

  async expectOpen(): Promise<void> {
    await expect(this.picker).toHaveAttribute('data-test-state', 'open');
  }

  async expectClosed(): Promise<void> {
    await expect(this.picker).toHaveAttribute('data-test-state', 'closed');
  }

  async select(name: string): Promise<void> {
    await this.item(name).click();
  }
}
