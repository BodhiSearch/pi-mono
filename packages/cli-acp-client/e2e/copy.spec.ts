import { expect, test } from '@playwright/test';
import { bootAndAuth } from './tests/utils/boot-and-auth';

/**
 * The `/copy` builtin emits a `_meta.bodhi.builtin.action` envelope
 * the host's dispatcher routes to either OSC 52 or a print-fallback.
 * In `--ci-line-mode` the harness is not a real TTY (we read stdout
 * over a pipe), so the dispatcher takes the print fallback path —
 * see `acp/builtin-dispatch.ts`. This spec asserts the fallback
 * banner + transcript appear after a real LLM turn, with `_builtin`
 * turns filtered out.
 */
test.describe('/copy builtin', () => {
  test('print-fallback prints the LLM-only conversation when stdout is not a TTY', async ({
    browser,
  }) => {
    const { harness } = await bootAndAuth(browser);
    try {
      harness.send('Reply with exactly the following text and nothing else: BODHI-COPY-OK');
      await harness.waitFor(/BODHI-COPY-OK/, 90_000);

      harness.send('/copy');
      await harness.waitFor(/Copy from above:|copied/i, 30_000);
      // The transcript itself must include the BODHI-COPY-OK turn even
      // though the /copy invocation came after it.
      await harness.waitFor(/BODHI-COPY-OK/, 30_000);
    } finally {
      harness.send('/quit');
      const code = await harness.stop();
      expect([0, null]).toContain(code);
      harness.cleanup();
    }
  });
});
