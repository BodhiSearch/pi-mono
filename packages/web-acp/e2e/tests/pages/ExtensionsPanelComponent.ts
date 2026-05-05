import { expect, type Page, type Locator } from '@playwright/test';

export class ExtensionsPanelComponent {
  readonly panel: Locator;

  constructor(private page: Page) {
    this.panel = page.locator('[data-testid="extensions-panel"]');
  }

  row(name: string): Locator {
    return this.page.locator(`[data-testid="extension-row-${name}"]`);
  }

  eventChip(name: string, event: string): Locator {
    return this.page.locator(`[data-testid="extension-row-${name}-event-${event}"]`);
  }

  async waitForCount(expected: number): Promise<void> {
    await expect(this.panel).toHaveAttribute('data-test-state', String(expected));
  }

  async expectMount(name: string, mountName: string): Promise<void> {
    await expect(this.row(name)).toHaveAttribute('data-test-state', mountName);
  }

  async expectEvents(name: string, events: readonly string[]): Promise<void> {
    for (const event of events) {
      await expect(this.eventChip(name, event)).toHaveText(event);
    }
  }
}
