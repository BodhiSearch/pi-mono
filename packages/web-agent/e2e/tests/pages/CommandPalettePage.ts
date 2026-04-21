import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Page object for the slash-command autocomplete palette.
 *
 * Selectors rely on the `data-testid` / `data-test-state` surface
 * emitted by `CommandPalette.tsx`. The palette is an inline popover
 * that only renders while the user is typing a `/` prefix in the
 * chat input — tests should ensure the input is enabled (logged in)
 * before driving it.
 */
export class CommandPalettePage {
  readonly root: Locator;
  readonly emptyState: Locator;

  constructor(private readonly page: Page) {
    this.root = page.locator('[data-testid="command-palette"]');
    this.emptyState = page.locator('[data-testid="command-palette-empty"]');
  }

  option(name: string): Locator {
    return this.page.locator(`[data-testid="command-option-${name}"]`);
  }

  activeOption(): Locator {
    return this.page.locator('[data-testid="command-palette"] [data-active-option="true"]');
  }

  async expectOpen(): Promise<void> {
    await expect(this.root).toHaveAttribute('data-test-state', 'open');
  }

  async expectClosed(): Promise<void> {
    await expect(this.root).toHaveAttribute('data-test-state', 'closed');
  }
}
