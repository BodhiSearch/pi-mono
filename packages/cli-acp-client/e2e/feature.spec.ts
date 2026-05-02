import { expect, test } from '@playwright/test';
import { bootAndAuth } from './tests/utils/boot-and-auth';

/**
 * `/feature` exercises the `_bodhi/features/list` and
 * `_bodhi/features/set` ext-methods through the in-process duplex.
 * Because a session is required for these methods, the spec sends a
 * trivial prompt first to spin one up, then toggles `bashEnabled`
 * off → on and re-reads the snapshot to confirm the override
 * landed.
 */
test.describe('/feature', () => {
  test('toggles bashEnabled and reads back the override', async ({ browser }) => {
    const { harness } = await bootAndAuth(browser);
    try {
      harness.send('Reply with the single word: pong.');
      await harness.waitFor(/pong/i, 90_000);

      harness.send('/feature list');
      await harness.waitFor(/bashEnabled/, 30_000);

      harness.send('/feature bashEnabled off');
      await harness.waitFor(/Feature 'bashEnabled' set to off/, 30_000);

      harness.send('/feature list');
      await harness.waitFor(/bashEnabled\s+off/, 30_000);

      harness.send('/feature bashEnabled on');
      await harness.waitFor(/Feature 'bashEnabled' set to on/, 30_000);
    } finally {
      harness.send('/quit');
      const code = await harness.stop();
      expect([0, null]).toContain(code);
      harness.cleanup();
    }
  });
});
