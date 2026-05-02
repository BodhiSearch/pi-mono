import type { Browser } from '@playwright/test';
import { CliHarness, type CliHarnessOptions } from './cli-harness';
import { driveOAuthFlow } from './auth-driver';
import { getTestState } from '../global-setup';

export interface BootedHarness {
  harness: CliHarness;
  state: ReturnType<typeof getTestState>;
}

/**
 * Boot the CLI in line-mode, drive the OAuth flow against the test
 * BodhiApp + Keycloak, and select the registered OpenAI model.
 *
 * Returns the live harness ready to send commands. The caller is
 * responsible for `harness.stop()` + `harness.cleanup()` in
 * `afterEach` (consistent with `cli.spec.ts`).
 *
 * Used by every spec under `e2e/tests/specs/` so we don't repeat the
 * OAuth dance ten times.
 */
export async function bootAndAuth(
  browser: Browser,
  opts: { selectModel?: boolean; harnessOpts?: CliHarnessOptions } = {}
): Promise<BootedHarness> {
  const state = getTestState();
  const harness = await CliHarness.start({ echo: !!process.env.CLI_ECHO, ...opts.harnessOpts });

  await harness.waitFor(/cli-acp - type \/help/, 30_000);
  harness.send(`/host ${state.bodhiServerUrl}`);

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

  if (opts.selectModel !== false) {
    harness.send(`/model ${state.modelId}`);
    await harness.waitFor(/Active model set to/, 10_000);
  }

  return { harness, state };
}
