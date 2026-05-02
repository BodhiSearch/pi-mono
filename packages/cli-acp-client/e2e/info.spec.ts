import { expect, test } from '@playwright/test';
import { bootAndAuth } from './tests/utils/boot-and-auth';

/**
 * Replaces the original `/session` builtin spec from web-acp.
 * The agent-side rename (`/session` → `/info`) is documented in
 * `packages/web-acp/TECHDEBT.md`; this spec proves the CLI now sees
 * the renamed builtin and that it is invokable without a model
 * selection (built-ins bypass the model gate).
 */
test.describe('/info builtin', () => {
  test('renders session stats and bypasses the model gate', async ({ browser }) => {
    const { harness, state } = await bootAndAuth(browser);
    try {
      harness.send('/info');
      // The built-in echoes a session block; the agent prefixes turn ids
      // with `assistant-turn-<n>` in line mode.
      await harness.waitFor(/Session/i, 30_000);
      await harness.waitFor(new RegExp(state.modelId.replace(/[/.]/g, '\\$&')), 30_000);
    } finally {
      harness.send('/quit');
      const code = await harness.stop();
      expect([0, null]).toContain(code);
      harness.cleanup();
    }
  });
});
