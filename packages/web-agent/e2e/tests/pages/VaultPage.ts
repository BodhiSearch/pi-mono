import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Page object for the vault status badge + side-panel file tree + viewer.
 *
 * All assertions go through the UI — no `page.evaluate` reaching into
 * ZenFS internals. The file tree auto-refreshes while the vault is
 * mounted, so asserting file presence after an agent-write is just
 * waiting for the entry to appear.
 */
export class VaultPage {
  readonly statusBadge: Locator;
  readonly statusName: Locator;
  readonly pickButton: Locator;
  readonly restoreButton: Locator;
  readonly panel: Locator;
  readonly fileTree: Locator;
  readonly viewer: Locator;
  readonly viewerContent: Locator;

  constructor(private readonly page: Page) {
    this.statusBadge = page.locator('[data-testid="vault-status"]');
    this.statusName = page.locator('[data-testid="vault-name"]');
    this.pickButton = page.locator('[data-testid="vault-pick"]');
    this.restoreButton = page.locator('[data-testid="vault-restore"]');
    this.panel = page.locator('[data-testid="vault-panel"]');
    this.fileTree = page.locator('[data-testid="vault-file-tree"]');
    this.viewer = page.locator('[data-testid="vault-file-viewer"]');
    this.viewerContent = page.locator('[data-testid="vault-file-content"]');
  }

  async waitForMounted(timeoutMs = 10_000): Promise<void> {
    await expect(this.statusBadge).toHaveAttribute('data-teststate', 'mounted', {
      timeout: timeoutMs,
    });
  }

  async expectName(name: string): Promise<void> {
    await expect(this.statusName).toHaveText(name);
  }

  fileEntry(absPath: string): Locator {
    return this.page.locator(`[data-testid="vault-file-entry"][data-path="${absPath}"]`);
  }

  async waitForFile(absPath: string, timeoutMs = 15_000): Promise<void> {
    await expect(this.fileEntry(absPath)).toBeVisible({ timeout: timeoutMs });
  }

  async openFile(absPath: string): Promise<void> {
    const entry = this.fileEntry(absPath);
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(this.viewer).toHaveAttribute('data-teststate', 'ready', { timeout: 5_000 });
    await expect(this.viewer).toHaveAttribute('data-path', absPath);
  }

  async currentFileContent(): Promise<string> {
    return (await this.viewerContent.textContent()) ?? '';
  }
}
