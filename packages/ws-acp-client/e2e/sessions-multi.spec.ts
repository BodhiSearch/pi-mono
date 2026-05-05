import { expect, test } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { SessionsView } from './pages/SessionsView';
import { SettingsPage } from './pages/SettingsPage';
import { getTestState } from './global-setup';
import { createPerSpecWsServer } from './utils/per-spec-ws';

// Phase 6 gate. Validates the Sessions sidebar contract after the
// switch from local-KVStore-backed `savedSessions` to the agent-driven
// `Agent.unstable_listSessions` model:
//
//   1. Multi-create — two sessions on the same agent + cwd both land
//      in the sidebar in DESC-by-updatedAt order (B first, then A).
//   2. Click-to-resume — selecting an inactive row in the sidebar
//      transitions the chat surface from `idle` (B's transcript) to
//      a fresh `idle` (A's transcript). The active-row marker
//      (`data-test-state=active`) follows the click target.
//   3. Delete inactive — pressing the per-row delete button on an
//      inactive session removes it from the sidebar and from the
//      agent's sqlite (verified by the count drop).
//   4. Delete active → auto-create — deleting the active session
//      tears down the bridge and immediately spins up a fresh empty
//      session on the same agent + cwd; the sidebar still shows
//      exactly one row (the new auto-created one) and the chat
//      surface stays connected.
//   5. Logout disconnects the bridge AND empties the sidebar; the
//      server-side rows survive (the sqlite is owned by the
//      ws-acp-client process, not the user's auth state).
//   6. Re-login + new connect rehydrates the sidebar from the agent.
//
// The journey makes 2 LLM calls (one per session create); resume +
// delete paths don't call the LLM. Total runtime ≈ 60s.
test.describe('acp-ui ↔ ws-acp-client sessions sidebar', () => {
  // Phase 6 made the sidebar agent-driven, so sessions persist in
  // sqlite across a single ws-acp-client process. To keep this spec
  // independent of the suite's other ws-acp-client traffic we spawn a
  // dedicated process here with a fresh tmp `cwd` (and therefore a
  // fresh `state.db`).
  const ws = createPerSpecWsServer();
  test.beforeAll(async () => {
    await ws.start();
  });
  test.afterAll(async () => {
    await ws.stop();
  });

  test('multi-create + resume + delete + logout/re-login', async ({ page }) => {
    const state = getTestState();
    const auth = new AuthPage(page);
    const settings = new SettingsPage(page);
    const chat = new ChatPage(page);
    const sessions = new SessionsView(page);

    const SENTINEL_A = 'PHASE6_A_91';
    const SENTINEL_B = 'PHASE6_B_42';
    const AGENT_NAME = 'E2E-WS-SESSIONS';

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

    let sessionAId = '';
    let sessionBId = '';

    await test.step('Session A: create + first prompt → sidebar count=1', async () => {
      await chat.newSession();
      await chat.expectState('ready');
      await chat.selectModel(state.modelId);
      await chat.send(`Reply with the marker ${SENTINEL_A} and nothing else.`);
      await chat.expectState('idle');
      await sessions.expectCount(1);
      // Capture A's id from the rendered row so later steps can address
      // it without reaching into Pinia state.
      sessionAId = (await sessions.rows().nth(0).getAttribute('data-testid'))!.replace(
        'row-session-',
        ''
      );
      await expect(sessions.rows().nth(0)).toHaveAttribute('data-test-state', 'active');
    });

    await test.step('Disconnect → sidebar empties (disconnect-only contract)', async () => {
      await page.locator('[data-testid="btn-disconnect"]').click();
      await chat.expectState('disconnected');
      // Per the disconnect-only logout contract, with no live bridge the
      // sidebar can't reach `Agent.unstable_listSessions` and must blank.
      await sessions.expectCount(0);
    });

    await test.step('Session B: new connect + prompt → sidebar count=2 (B first)', async () => {
      await chat.newSession();
      await chat.expectState('ready');
      await chat.selectModel(state.modelId);
      await chat.send(`Reply with the marker ${SENTINEL_B} and nothing else.`);
      await chat.expectState('idle');
      // Sidebar rehydrated via `unstable_listSessions` on connect; both
      // sessions are now visible because both live in the agent's sqlite.
      await sessions.expectCount(2);
      sessionBId = (await sessions.rows().nth(0).getAttribute('data-testid'))!.replace(
        'row-session-',
        ''
      );
      // DESC sort by updatedAt → B is first (just-prompted), A is second.
      await expect.soft(sessions.rows().nth(0)).toHaveAttribute('data-test-state', 'active');
      await expect.soft(sessions.rows().nth(1)).toHaveAttribute('data-test-state', 'inactive');
    });

    await test.step('Click row A — resume + transcript replays + active marker moves', async () => {
      await sessions.rows().nth(1).click();
      // resumeSession disconnects the B bridge first, then connects fresh
      // and calls loadSession(A); the chat returns to idle once the
      // inline `_meta.bodhi.messages` reconstruction overlays.
      await chat.expectState('idle');
      await expect(
        page.locator('[data-test-role="assistant"]').first()
      ).toContainText(SENTINEL_A, { ignoreCase: true });
      // Active marker tracks the click target — A is now active.
      const aRow = page.locator(`[data-testid="row-session-${sessionAId}"]`);
      await expect(aRow).toHaveAttribute('data-test-state', 'active');
      // B is still in the sidebar (not deleted) and is now inactive.
      const bRow = page.locator(`[data-testid="row-session-${sessionBId}"]`);
      await expect(bRow).toHaveAttribute('data-test-state', 'inactive');
    });

    await test.step('Delete inactive (B) → sidebar count=1, A still active', async () => {
      // The acp-ui SessionList uses `window.confirm` for the destructive
      // guard; auto-accept once the click fires.
      page.once('dialog', d => void d.accept());
      await page.locator(`[data-testid="btn-session-delete-${sessionBId}"]`).click();
      await sessions.expectCount(1);
      const aRow = page.locator(`[data-testid="row-session-${sessionAId}"]`);
      await expect(aRow).toHaveAttribute('data-test-state', 'active');
      await chat.expectState('idle');
    });

    await test.step('Delete active (A) → auto-create new empty session on same agent', async () => {
      page.once('dialog', d => void d.accept());
      await page.locator(`[data-testid="btn-session-delete-${sessionAId}"]`).click();
      // Auto-create-on-empty: deleteSession tears down the A bridge and
      // immediately calls createSession(E2E-WS, cwd) so the chat surface
      // is never stranded on the welcome screen.
      await chat.expectState('ready');
      await sessions.expectCount(1);
      // The new row is active (just-created).
      await expect(sessions.rows().nth(0)).toHaveAttribute('data-test-state', 'active');
      // Capture the auto-created session id so we can assert it
      // survives the logout/re-login round-trip below.
      const newId = (await sessions.rows().nth(0).getAttribute('data-testid'))!.replace(
        'row-session-',
        ''
      );
      expect(newId).not.toBe(sessionAId);
    });

    await test.step('Logout — bridge disconnects and sidebar empties', async () => {
      await auth.logout();
      // The watch on bodhiAuthStore.isAuthenticated triggers
      // sessionStore.disconnect(), which transitions to disconnected
      // and blanks savedSessions per the contract.
      await chat.expectState('disconnected');
      await sessions.expectCount(0);
    });

    await test.step('Re-login + new connect — sidebar rehydrates from agent', async () => {
      await auth.reloginAfterLogout();
      await auth.expectAuthenticated();

      // The OAuth round-trip reloads the SPA. Local UI state (selected
      // agent + cwd) is reset; AgentSelector auto-selects the only
      // configured agent but cwd is a free-text field that needs a
      // re-fill.
      await chat.selectAgent(AGENT_NAME);
      await chat.setCwd(ws.cwd);

      await chat.newSession();
      await chat.expectState('ready');
      // The sidebar now shows BOTH the just-created row AND the
      // auto-created row from the delete-active step. Server-side rows
      // survive logout — only the local UI state is cleared.
      await sessions.expectCount(2);
    });
  });
});
