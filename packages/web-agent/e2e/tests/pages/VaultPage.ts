import { expect, type Locator, type Page } from '@playwright/test';

/**
 * VaultPage — page object for vault status + test-only file readback.
 */
export class VaultPage {
  readonly statusBadge: Locator;
  readonly statusName: Locator;
  readonly pickButton: Locator;
  readonly restoreButton: Locator;

  constructor(private readonly page: Page) {
    this.statusBadge = page.locator('[data-testid="vault-status"]');
    this.statusName = page.locator('[data-testid="vault-name"]');
    this.pickButton = page.locator('[data-testid="vault-pick"]');
    this.restoreButton = page.locator('[data-testid="vault-restore"]');
  }

  async waitForMounted(timeoutMs = 10_000): Promise<void> {
    await expect(this.statusBadge).toHaveAttribute('data-teststate', 'mounted', {
      timeout: timeoutMs,
    });
  }

  async expectName(name: string): Promise<void> {
    await expect(this.statusName).toHaveText(name);
  }

  /**
   * Read a file from the dev-seeded InMemory vault via the test-only
   * `window.__zenfsFs` hook that `in-memory-vault.ts` exposes. This is NOT
   * a production API — it only exists under `import.meta.env.DEV`.
   */
  async readFile(absPath: string): Promise<string> {
    return await this.page.evaluate(async path => {
      const w = window as unknown as {
        __zenfsFs?: { readFile: (p: string, opts: { encoding: string }) => Promise<string> };
      };
      if (!w.__zenfsFs) {
        throw new Error('__zenfsFs not available — dev-seed not mounted');
      }
      return await w.__zenfsFs.readFile(path, { encoding: 'utf8' });
    }, absPath);
  }
}
