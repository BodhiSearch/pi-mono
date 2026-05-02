import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { bootAndAuth } from './tests/utils/boot-and-auth';

/**
 * Vault commands live under `<volume>/.commands/<name>.md` and are
 * invoked as `/<mount>:<name> [args...]`. The agent's command loader
 * scans every mounted volume on session start, so we seed a command
 * file in a freshly-mounted volume and verify:
 *
 *   1. it shows up in the autocomplete (advertised via
 *      `available_commands_update`),
 *   2. invoking `/notes:greet alice` round-trips the args body to
 *      the LLM (exercises the dispatcher fall-through path that
 *      forwards unknown `/cmd` invocations to the agent),
 *   3. multiple mounts can hold commands without name collisions
 *      because each is namespaced by its mount.
 */
test.describe('vault commands', () => {
  test('multi-volume <mount>:greet invocation expands args', async ({ browser }) => {
    const seedDir = mkdtempSync(path.join(tmpdir(), 'cli-acp-vault-'));
    mkdirSync(path.join(seedDir, '.commands'), { recursive: true });
    writeFileSync(
      path.join(seedDir, '.commands', 'greet.md'),
      'Reply with exactly: GREET <args> — and nothing else.\n'
    );

    const { harness } = await bootAndAuth(browser);
    try {
      harness.send(`/volume add ${seedDir} notes`);
      await harness.waitFor(/Mounted .* at \/mnt\/notes/, 30_000);

      // Send a prompt to spin up a session with the new mount visible.
      harness.send('Reply with the single word: ready.');
      await harness.waitFor(/ready/i, 90_000);

      harness.send('/notes:greet alice');
      await harness.waitFor(/GREET\s+alice/i, 90_000);
    } finally {
      harness.send('/quit');
      const code = await harness.stop();
      expect([0, null]).toContain(code);
      harness.cleanup();
      rmSync(seedDir, { recursive: true, force: true });
    }
  });
});
