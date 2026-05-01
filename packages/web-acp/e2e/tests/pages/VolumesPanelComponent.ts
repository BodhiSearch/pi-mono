import { expect, type Page, type Locator } from '@playwright/test';

export class VolumesPanelComponent {
  readonly panel: Locator;

  constructor(private page: Page) {
    this.panel = page.locator('[data-testid="volumes-panel"]');
  }

  row(name: string): Locator {
    return this.page.locator(`[data-testid="volume-row-${name}"]`);
  }

  removeButton(name: string): Locator {
    return this.page.locator(`[data-testid="btn-remove-volume-${name}"]`);
  }

  async waitForCount(expected: number): Promise<void> {
    await expect(this.panel).toHaveAttribute('data-test-state', String(expected));
  }

  async expectMounted(name: string): Promise<void> {
    await expect(this.row(name)).toHaveAttribute('data-test-state', 'mounted');
  }

  async remove(name: string): Promise<void> {
    await this.removeButton(name).click();
  }
}
