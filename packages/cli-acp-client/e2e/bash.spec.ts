import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { bootAndAuth } from './tests/utils/boot-and-auth';

/**
 * Proves the agent's `bash` tool resolves `/mnt/cwd/...` against the
 * harness's per-test temp `cwd`. The CLI auto-mounts `$cwd` at boot
 * (see `services/assemble.ts`), so writing a file at `<cwd>/sentinel.txt`
 * and asking the agent to `cat /mnt/cwd/sentinel.txt` exercises:
 *
 *   - vault-registry mount lifecycle,
 *   - just-bash filesystem proxy through ZenFS,
 *   - tool_call rendering through the StreamController.
 */
test.describe('bash tool', () => {
  test('cat /mnt/cwd/sentinel.txt round-trips through the bash tool', async ({ browser }) => {
    const { harness } = await bootAndAuth(browser);
    try {
      writeFileSync(path.join(harness.cwd, 'sentinel.txt'), 'BASH-SENTINEL-OK\n');
      harness.send('Run the bash tool with: cat /mnt/cwd/sentinel.txt');
      await harness.waitFor(/BASH-SENTINEL-OK/, 90_000);
    } finally {
      harness.send('/quit');
      const code = await harness.stop();
      expect([0, null]).toContain(code);
      harness.cleanup();
    }
  });
});
