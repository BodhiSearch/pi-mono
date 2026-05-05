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

  tagsList(name: string): Locator {
    return this.page.locator(`[data-testid="volume-row-${name}-tags"]`);
  }

  tagChip(name: string, tag: string): Locator {
    return this.page.locator(`[data-testid="volume-row-${name}-tag-${tag}"]`);
  }

  async waitForCount(expected: number): Promise<void> {
    await expect(this.panel).toHaveAttribute('data-test-state', String(expected));
  }

  async expectMounted(name: string): Promise<void> {
    await expect(this.row(name)).toHaveAttribute('data-test-state', 'mounted');
  }

  async expectTags(name: string, tags: readonly string[]): Promise<void> {
    if (tags.length === 0) {
      await expect(this.tagsList(name)).toHaveCount(0);
      return;
    }
    await expect(this.tagsList(name)).toHaveAttribute('data-test-state', String(tags.length));
    for (const tag of tags) {
      await expect(this.tagChip(name, tag)).toHaveText(tag);
    }
  }

  async remove(name: string): Promise<void> {
    await this.removeButton(name).click();
  }
}
