import { expect, test } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { SettingsPage } from './pages/SettingsPage';
import { getTestState } from './global-setup';

// Phase 1 gate: a single journey that proves the Bodhi OAuth round-trip
// works end-to-end through acp-ui's web build. We:
//   1. Land on a fresh acp-ui page (unauthenticated).
//   2. Open Settings and configure the Bodhi server URL coming from the
//      booted napi server (global-setup writes its URL into
//      `.test-state.json`).
//   3. Trigger Login from the header and walk Keycloak.
//   4. Assert the auth section flips to `authenticated`.
//   5. Sanity-check Logout flips us back to `unauthenticated`.
//
// All assertions go through the visible UI / data-test-* attributes —
// no `page.evaluate`, no `localStorage` peeking. Failure of any soft
// step still continues so the trace shows every step of the journey.
test.describe('acp-ui ↔ bodhi auth', () => {
  test('user authenticates against Bodhi via Keycloak round-trip', async ({ page }) => {
    const state = getTestState();
    const auth = new AuthPage(page);
    const settings = new SettingsPage(page);

    await test.step('open acp-ui (unauthenticated)', async () => {
      await page.goto('/');
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();
      await auth.expectUnauthenticated();
      // Login button is gated on "server URL configured".
      await expect(auth.loginButton).toBeDisabled();
    });

    await test.step('configure Bodhi server URL via Settings', async () => {
      await settings.open();
      await settings.setBodhiServerUrl(state.bodhiServerUrl);
      const status = await settings.bodhiServerStatus();
      expect.soft(status).toBe('configured');
      await expect(settings.bodhiServerCurrent).toHaveText(state.bodhiServerUrl);
      await settings.close();
      await expect(auth.loginButton).toBeEnabled();
    });

    await test.step('login through Keycloak access-request flow', async () => {
      await auth.login({ username: state.username, password: state.password });
      await auth.expectAuthenticated();
      // The user's display name should populate after token decode.
      await expect.soft(auth.authName).toBeVisible();
    });

    await test.step('logout returns the session to unauthenticated', async () => {
      await auth.logout();
      await auth.expectUnauthenticated();
    });
  });
});
