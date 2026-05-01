import { expect, type Page, type Locator } from '@playwright/test';

export type FeatureKey = 'bashEnabled' | 'forceToolCall';
export type ToggleState = 'on' | 'off';

export class FeaturePanelComponent {
  readonly panel: Locator;

  constructor(private page: Page) {
    this.panel = page.locator('[data-testid="features-panel"]');
  }

  row(key: FeatureKey): Locator {
    return this.page.locator(`[data-testid="feature-row-${key}"]`);
  }

  toggle(key: FeatureKey): Locator {
    return this.page.locator(`[data-testid="feature-toggle-${key}"]`);
  }

  async expectState(key: FeatureKey, state: ToggleState): Promise<void> {
    await expect(this.row(key)).toHaveAttribute('data-test-state', state);
  }

  async setState(key: FeatureKey, desired: ToggleState): Promise<void> {
    const current = await this.row(key).getAttribute('data-test-state');
    if (current === desired) return;
    await this.toggle(key).click();
    await this.expectState(key, desired);
  }

  /** DEV-only — the row is hidden in production builds, so guard with isVisible(). */
  async setForceToolCallOnIfAvailable(): Promise<void> {
    const toggle = this.toggle('forceToolCall');
    if (await toggle.isVisible().catch(() => false)) {
      await this.setState('forceToolCall', 'on');
    }
  }
}
