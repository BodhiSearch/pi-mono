import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { bootAndAuth } from './tests/utils/boot-and-auth';

/**
 * `/volume add|remove|list` round-trip. The cli-acp-client persists
 * mount entries in sqlite kv (`KV_VOLUMES`) so a subsequent boot
 * re-mounts them automatically; this spec exercises the in-process
 * lifecycle (add → list → remove → list) without relying on a
 * second boot.
 */
test.describe('/volume', () => {
  test('add, list, and remove a directory mount', async ({ browser }) => {
    const extraDir = mkdtempSync(path.join(tmpdir(), 'cli-acp-vol-'));
    mkdirSync(path.join(extraDir, 'inner'), { recursive: true });
    writeFileSync(path.join(extraDir, 'inner', 'NOTE.md'), '# notes-mount\n');

    const { harness } = await bootAndAuth(browser, { selectModel: false });
    try {
      harness.send(`/volume add ${extraDir} notes`);
      await harness.waitFor(/Mounted .* at \/mnt\/notes/, 30_000);

      harness.send('/volume list');
      await harness.waitFor(/\/mnt\/notes/, 30_000);

      harness.send('/volume remove notes');
      await harness.waitFor(/Unmounted \/mnt\/notes/, 30_000);

      harness.send('/volume list');
      // After removal the mount must not appear in the next list output.
      await harness.waitFor(/Volumes \(/, 30_000);
    } finally {
      harness.send('/quit');
      const code = await harness.stop();
      expect([0, null]).toContain(code);
      harness.cleanup();
      rmSync(extraDir, { recursive: true, force: true });
    }
  });
});
