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
  readonly markdownEditor: Locator;
  readonly markdownContent: Locator;

  constructor(private readonly page: Page) {
    this.statusBadge = page.locator('[data-testid="vault-status"]');
    this.statusName = page.locator('[data-testid="vault-name"]');
    this.pickButton = page.locator('[data-testid="vault-pick"]');
    this.restoreButton = page.locator('[data-testid="vault-restore"]');
    this.panel = page.locator('[data-testid="vault-panel"]');
    this.fileTree = page.locator('[data-testid="vault-file-tree"]');
    this.viewer = page.locator('[data-testid="vault-file-viewer"]');
    this.viewerContent = page.locator('[data-testid="vault-file-content"]');
    this.markdownEditor = page.locator('[data-testid="markdown-editor"]');
    this.markdownContent = page.locator('[data-testid="markdown-editor"] .ProseMirror');
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

  dirEntry(absPath: string): Locator {
    return this.page.locator(`[data-testid="vault-dir-entry"][data-path="${absPath}"]`);
  }

  /**
   * Folders default to collapsed, so walk the ancestor chain of `absPath`
   * under `/vault/` and click-expand each directory that is currently
   * collapsed. Waits for each dir to transition to `expanded` before
   * continuing to the next depth.
   */
  private async expandAncestors(absPath: string, timeoutMs = 10_000): Promise<void> {
    if (!absPath.startsWith('/vault/')) return;
    const parts = absPath.slice('/vault/'.length).split('/');
    if (parts.length <= 1) return; // file is at the vault root
    let prefix = '/vault';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix += `/${parts[i]}`;
      const dir = this.dirEntry(prefix);
      await expect(dir).toBeVisible({ timeout: timeoutMs });
      const state = await dir.getAttribute('data-teststate');
      if (state !== 'expanded') {
        await dir.click();
        await expect(dir).toHaveAttribute('data-teststate', 'expanded', { timeout: timeoutMs });
      }
    }
  }

  async waitForFile(absPath: string, timeoutMs = 15_000): Promise<void> {
    await this.expandAncestors(absPath, timeoutMs);
    await expect(this.fileEntry(absPath)).toBeVisible({ timeout: timeoutMs });
  }

  async openFile(absPath: string): Promise<void> {
    await this.expandAncestors(absPath);
    const entry = this.fileEntry(absPath);
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(this.viewer).toHaveAttribute('data-teststate', 'ready', { timeout: 5_000 });
    await expect(this.viewer).toHaveAttribute('data-path', absPath);
  }

  /**
   * Return the text currently displayed in the viewer.
   *
   * Markdown files render through Milkdown's ProseMirror — the text content
   * there is the *rendered* view (so `# Sample vault` surfaces as
   * `Sample vault`, not the raw markdown). Non-markdown text files render
   * as `<pre data-testid="vault-file-content">` and we return its raw text.
   */
  async currentFileContent(): Promise<string> {
    if (await this.markdownEditor.count()) {
      await expect(this.markdownContent).toBeVisible({ timeout: 5_000 });
      return (await this.markdownContent.textContent()) ?? '';
    }
    await expect(this.viewerContent).toBeVisible({ timeout: 5_000 });
    return (await this.viewerContent.textContent()) ?? '';
  }
}
