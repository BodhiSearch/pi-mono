import { expect, test } from '@playwright/test';
import { bootAndAuth } from './tests/utils/boot-and-auth';

/**
 * `/mcp` add → list → remove round-trip.
 *
 * Adding an MCP URL writes into sqlite kv (`KV_REQUESTED_MCPS`).
 * `/mcp list` then merges that wishlist with the live BodhiApp
 * instance catalog (which is empty in this minimal e2e fixture) and
 * reports the URL under "Pending or denied". Removing the URL drops
 * it from the list. We deliberately do not exercise OAuth re-login
 * here — that path is covered by `web-acp/e2e/mcp.spec.ts` against
 * a real provisioned MCP server.
 */
test.describe('/mcp wishlist round-trip', () => {
  test('adds + lists + removes a requested MCP URL', async ({ browser }) => {
    const { harness } = await bootAndAuth(browser, { selectModel: false });
    try {
      const url = 'https://example.com/mcp';
      harness.send(`/mcp add ${url}`);
      await harness.waitFor(/Added .*example\.com/, 30_000);

      harness.send('/mcp list');
      await harness.waitFor(/example\.com/, 30_000);

      harness.send(`/mcp remove ${url}`);
      await harness.waitFor(/Removed .*example\.com/, 30_000);
    } finally {
      harness.send('/quit');
      const code = await harness.stop();
      expect([0, null]).toContain(code);
      harness.cleanup();
    }
  });
});
