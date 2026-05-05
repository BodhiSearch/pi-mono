import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { SessionsView } from './pages/SessionsView';
import { SettingsPage } from './pages/SettingsPage';
import { getTestState } from './global-setup';
import { createPerSpecWsServer } from './utils/per-spec-ws';

// Phase 9 gate. Drives the new acp-ui FeaturesPanel and verifies the
// post-refactor `_bodhi/feature` config-options surface end-to-end:
//
//   1. New session — panel renders with bashEnabled=on (default),
//      forceToolCall=off (default) → enabled count = 1.
//   2. Toggle bashEnabled off → enabled count = 0; both rows expose
//      data-test-state with the new value.
//   3. Reload + click resumed session — bashEnabled survives the
//      reload via `LoadSessionResponse.configOptions` (NOT via local
//      state, which is wiped on disconnect).
//   4. Toggle bashEnabled on + forceToolCall on; pre-seed
//      `<cwd>/marker.txt` with a beacon and ask the agent to bash-read
//      it. With both toggles on, `tool_choice: 'required'` deterministically
//      forces a tool call and the beacon must surface in the transcript.
//
// 2 LLM calls. ~30-45s on a warm laptop.
const BEACON = 'PHASE9_FEATURE_BEACON_K81';

test.describe('acp-ui ↔ ws-acp-client feature toggles (configOptions)', () => {
  const ws = createPerSpecWsServer();

  test.beforeAll(async () => {
    await ws.start();
  });
  test.afterAll(async () => {
    await ws.stop();
  });

  test('panel renders defaults, toggles persist across reload, drives bash tool', async ({ page }) => {
    const state = getTestState();
    const auth = new AuthPage(page);
    const settings = new SettingsPage(page);
    const chat = new ChatPage(page);
    const sessions = new SessionsView(page);

    const AGENT_NAME = 'E2E-WS-FEATURES';
    const panel = page.locator('[data-testid="features-panel"]');
    const bashRow = page.locator('[data-testid="feature-row-bashEnabled"]');
    const bashToggle = page.locator('[data-testid="feature-toggle-bashEnabled"]');
    const forceRow = page.locator('[data-testid="feature-row-forceToolCall"]');
    const forceToggle = page.locator('[data-testid="feature-toggle-forceToolCall"]');

    await test.step('Setup: login, configure Bodhi server, add WS agent', async () => {
      await page.goto('/');
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();

      await settings.open();
      await settings.setBodhiServerUrl(state.bodhiServerUrl);
      await settings.close();

      await auth.login({ username: state.username, password: state.password });
      await auth.expectAuthenticated();

      await settings.open();
      await settings.addAgent({
        name: AGENT_NAME,
        transport: 'websocket',
        url: ws.url,
      });
      await settings.close();

      await chat.selectAgent(AGENT_NAME);
      await chat.setCwd(ws.cwd);
    });

    await test.step('New session — panel renders defaults (bashEnabled=on, forceToolCall=off)', async () => {
      await chat.newSession();
      await chat.expectState('ready');
      await chat.selectModel(state.modelId);

      // Panel mounts as soon as the session is connected and configOptions
      // arrive on `NewSessionResponse`. Defaults from FEATURE_DEFAULTS:
      // bashEnabled=true, forceToolCall=false → enabled count = 1.
      await expect(panel).toHaveAttribute('data-test-state', '1');
      await expect(bashRow).toHaveAttribute('data-test-state', 'on');
      await expect(forceRow).toHaveAttribute('data-test-state', 'off');
    });

    await test.step('Toggle bashEnabled off → panel reflects new snapshot', async () => {
      await bashToggle.click();
      // The agent echoes the full configOptions snapshot in the
      // `session/set_config_option` response; the store ingests that
      // verbatim and the row flips immediately.
      await expect(bashRow).toHaveAttribute('data-test-state', 'off');
      await expect(panel).toHaveAttribute('data-test-state', '0');
    });

    await test.step('Reload + reconnect + resume → bashEnabled stays off (configOptions on load)', async () => {
      // Capture the active session id from the only currently-rendered row
      // before the reload tears the SPA down. After reconnect, this is the
      // OLDER session in DESC-sorted order — index 1 in the list.
      const activeRow = page.locator('[data-testid^="row-session-"][data-test-state="active"]');
      await expect(activeRow).toHaveCount(1);

      await page.reload();
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();
      await chat.expectState('disconnected');

      // Phase 6: the sidebar is agent-driven, so a reload empties it
      // until we open a fresh connection. Spawn a throwaway new session
      // to repopulate the sidebar from `unstable_listSessions`.
      await chat.selectAgent(AGENT_NAME);
      await chat.setCwd(ws.cwd);
      await chat.newSession();
      await chat.expectState('ready');
      await sessions.expectCount(2);

      // Click the older row (index 1 in DESC-sorted list) → resumeSession
      // → `LoadSessionResponse.configOptions` carries the persisted
      // `bashEnabled=off`. Session A had no LLM turns yet, so the chat
      // surface lands on `ready` (not `idle`) post-load.
      await sessions.rows().nth(1).click();
      await chat.expectState('ready');
      await expect(bashRow).toHaveAttribute('data-test-state', 'off');
      await expect(forceRow).toHaveAttribute('data-test-state', 'off');
      await expect(panel).toHaveAttribute('data-test-state', '0');
    });

    await test.step('Toggle bashEnabled on + forceToolCall on → drives bash tool to read beacon', async () => {
      await bashToggle.click();
      await expect(bashRow).toHaveAttribute('data-test-state', 'on');
      await forceToggle.click();
      await expect(forceRow).toHaveAttribute('data-test-state', 'on');
      await expect(panel).toHaveAttribute('data-test-state', '2');

      // Pre-seed a marker file in the cwd. ws-acp-client mounts <cwd>
      // at /mnt/cwd via PassthroughFS, so the bash tool can read it.
      await writeFile(join(ws.cwd, 'marker.txt'), `${BEACON}\n`, 'utf8');

      await chat.send(
        'Use the bash tool to run `cat /mnt/cwd/marker.txt` and respond with the file contents verbatim.'
      );
      await chat.expectState('idle');
      // The beacon must surface in the rendered transcript — either in
      // the assistant bubble or a tool-call summary.
      await expect(chat.messages.last()).toContainText(BEACON);
    });
  });
});
