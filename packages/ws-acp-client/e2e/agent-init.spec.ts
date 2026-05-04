import { expect, test } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { getTestState } from './global-setup';

// Phase 2 gate: a single blackbox journey that proves
//   1. ws-acp-client (booted by global-setup) accepts a WebSocket connection
//      from acp-ui's web build,
//   2. the agent advertises an `authMethods` array on `initialize`, and
//   3. acp-ui surfaces an `auth-required` UI state so the user can resolve
//      the auth flow before any LLM contact.
//
// This intentionally skips Bodhi login — Phase 3 wires up the auto-token
// push, and that path swallows the dialog when both `bodhi-token` is
// advertised AND a stored token exists. Without a stored token, the
// dialog must surface and the user can only cancel it.
test.describe('acp-ui ↔ ws-acp-client agent init', () => {
  test('add WS agent → auth-required surfaces → cancel returns to disconnected', async ({
    page,
  }) => {
    const state = getTestState();
    const auth = new AuthPage(page);
    const settings = new SettingsPage(page);
    const chat = new ChatPage(page);

    await test.step('Land on a fresh acp-ui page (no Bodhi login)', async () => {
      await page.goto('/');
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();
      await chat.expectState('disconnected');
      await auth.expectUnauthenticated();
    });

    await test.step('Open Settings and add a WebSocket agent', async () => {
      await settings.open();
      await settings.addAgent({
        name: 'E2E-WS',
        transport: 'websocket',
        url: state.wsUrl,
      });
      await expect.soft(settings.row('E2E-WS')).toHaveAttribute(
        'data-test-state',
        'websocket'
      );
      await settings.close();
    });

    await test.step('Pick the new agent and start a session at the agent cwd', async () => {
      await chat.selectAgent('E2E-WS');
      await chat.setCwd(state.cwd);
      await chat.newSession();
    });

    await test.step('Auth-required UI surfaces because no token has been pushed yet', async () => {
      await chat.expectState('auth-required');
      await expect(auth.methodDialog).toHaveAttribute(
        'data-test-state',
        'open'
      );
      await expect.soft(auth.methodButton('bodhi-token')).toBeVisible();
    });

    await test.step('Cancel the dialog — chat returns to disconnected', async () => {
      await auth.cancelMethodDialog();
      await chat.expectState('disconnected');
    });

    await test.step('Clean up the test agent so reruns start fresh', async () => {
      await settings.open();
      await settings.deleteAgent('E2E-WS');
      await settings.close();
    });
  });
});
