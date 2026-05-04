import { expect, test } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { getTestState } from './global-setup';

// Phase 3 gate: a single blackbox journey that proves the auto-token
// push works.
//   1. Login to Bodhi → token + serverUrl land in the bodhiAuth store.
//   2. Add a websocket agent for the spawned ws-acp-client.
//   3. Open it → acp-ui sees `bodhi-token` in `authMethods`, holds a
//      Bodhi token, and pushes it via `authenticate(_meta.bodhi)` —
//      no method dialog ever surfaces.
//   4. Chat surface settles on `ready`; ModelPicker is `loaded`.
//   5. Send a sentinel prompt; the surface goes `streaming` then
//      `idle`; the assistant bubble contains the sentinel.
test.describe('acp-ui ↔ ws-acp-client prompt round-trip', () => {
  test('auto-auth + prompt → streaming → idle', async ({ page }) => {
    const state = getTestState();
    const auth = new AuthPage(page);
    const settings = new SettingsPage(page);
    const chat = new ChatPage(page);

    await test.step('Land on a fresh acp-ui page', async () => {
      await page.goto('/');
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();
      await chat.expectState('disconnected');
    });

    await test.step('Authenticate to Bodhi (sets server URL + access token)', async () => {
      await settings.open();
      await settings.setBodhiServerUrl(state.bodhiServerUrl);
      expect.soft(await settings.bodhiServerStatus()).toBe('configured');
      await settings.close();
      await auth.login({ username: state.username, password: state.password });
      await auth.expectAuthenticated();
    });

    await test.step('Add a WebSocket agent pointing at ws-acp-client', async () => {
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

    await test.step('Pick the agent and open a session — no auth prompt', async () => {
      await chat.selectAgent('E2E-WS');
      await chat.setCwd(state.cwd);
      await chat.newSession();
      // The auth-method dialog must NOT surface — bodhi-token is pushed
      // silently. Cheap soft-assert before waiting on `ready`.
      await chat.expectState('ready');
      await expect.soft(auth.methodDialog).toBeHidden();
    });

    await test.step('ModelPicker reports loaded', async () => {
      await expect(chat.modelPicker).toHaveAttribute(
        'data-test-state',
        'loaded'
      );
    });

    await test.step('Pick the provisioned model + send the sentinel prompt', async () => {
      await chat.selectModel(state.modelId);
      await chat.send('reply with the single word PONG and nothing else');
      // Terminal state. `streaming` is racy on a fast LLM round-trip
      // so we wait directly on `idle`; that implicitly confirms the
      // assistant message landed and `isLoading` flipped back.
      await chat.expectState('idle');
    });

    await test.step('Assistant bubble contains the sentinel', async () => {
      // The user prompt is bubble 0 (added locally by sendPrompt) and
      // the assistant reply is bubble 1 (streamed via agent_message_chunk).
      await expect(chat.bubble(1, 'assistant')).toContainText('pong', {
        ignoreCase: true,
      });
    });

    await test.step('Clean up the test agent so reruns start fresh', async () => {
      await settings.open();
      await settings.deleteAgent('E2E-WS');
      await settings.close();
    });
  });
});
