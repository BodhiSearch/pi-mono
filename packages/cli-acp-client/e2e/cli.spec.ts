import { test, expect } from '@playwright/test';
import { CliHarness } from './tests/utils/cli-harness';
import { driveOAuthFlow } from './tests/utils/auth-driver';
import { getTestState } from './tests/global-setup';

test.describe('cli-acp-client end-to-end', () => {
  let harness: CliHarness | undefined;

  test.afterEach(async () => {
    if (harness) {
      await harness.stop().catch(() => {});
      harness.cleanup();
      harness = undefined;
    }
  });

  test('/host triggers OAuth, /models lists the registered model, prompt round-trips', async ({
    browser,
  }) => {
    const state = getTestState();
    harness = await CliHarness.start({ echo: !!process.env.CLI_ECHO });

    // Banner is the first deterministic line we expect.
    await harness.waitFor(/cli-acp - type \/help/, 30_000);

    harness.send(`/host ${state.bodhiServerUrl}`);
    // The print-only opener writes the review URL on its own line right
    // after the "Open this URL ..." prompt. We capture the first
    // localhost-bodhi URL after that marker.
    await harness.waitFor(/Open this URL in your browser/, 60_000);
    const urlLine = await harness.waitFor(/^https?:\/\/(?:localhost|127\.0\.0\.1):/, 30_000);
    const reviewUrl = urlLine.trim();

    const context = await browser.newContext();
    try {
      await driveOAuthFlow({
        context,
        reviewUrl,
        credentials: { username: state.username, password: state.password },
      });
    } finally {
      await context.close();
    }

    await harness.waitFor(/Login successful/, 90_000);
    await harness.waitFor(/\[status\] authenticated to/, 30_000);

    harness.send('/models');
    await harness.waitFor(new RegExp(state.modelId.replace(/[/.]/g, '\\$&')), 30_000);

    harness.send(`/model ${state.modelId}`);
    await harness.waitFor(/Active model set to/, 10_000);

    harness.send('Reply with the single word: pong.');
    await harness.waitFor(/^\[(?:bot|stream)\].*pong/i, 90_000);

    harness.send('/quit');
    const code = await harness.stop();
    expect(code).toBe(0);
  });
});
