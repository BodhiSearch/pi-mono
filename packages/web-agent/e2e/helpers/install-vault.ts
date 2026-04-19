import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * installVault — seeds the page with a real-directory vault fixture.
 *
 * Walks `e2e/data/<vaultName>/` Node-side, builds a `Record<absolutePath, content>`
 * rooted at `/vault`, and injects it into `window.__zenfsSeed` via
 * `page.addInitScript` so the app's dev-mode boot path picks it up before any
 * React render occurs.
 *
 * In production (`import.meta.env.PROD`) the seed is ignored and the app falls
 * back to the FSA picker + WebAccess backend — so calling this helper outside
 * a dev/test build is a no-op.
 */
export async function installVault(page: Page, vaultName: string): Promise<void> {
  const root = join(process.cwd(), 'e2e', 'data', vaultName);
  const files: Record<string, string> = {};

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const rel = '/' + relative(root, abs).split(/[\\/]/).join('/');
        files['/vault' + rel] = await readFile(abs, 'utf8');
      }
    }
  }

  await walk(root);

  await page.addInitScript(
    ({ files, name }) => {
      (window as unknown as { __zenfsSeed: unknown }).__zenfsSeed = {
        files,
        name,
      };
    },
    { files, name: vaultName }
  );
}
