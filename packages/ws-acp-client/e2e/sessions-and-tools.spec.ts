import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { SessionsView } from './pages/SessionsView';
import { SettingsPage } from './pages/SettingsPage';
import { getTestState } from './global-setup';
import { createPerSpecWsServer } from './utils/per-spec-ws';

// Phase 4 gate: the broadest journey test in the suite. Drives the
// post-Phase-3 stack through the workflows that aren't covered by
// the simpler init / prompt gates:
//
//   1. multi-session lifecycle — create A, disconnect, create B,
//      both list in the sidebar in the right order, switching back
//      to A replays its transcript through `loadSession`,
//   2. tool execution — pre-seed `<cwd>/hello.txt` and ask the
//      agent to `cat /mnt/cwd/hello.txt`. The bash built-in tool
//      goes through the cwd PassthroughFS volume mounted by
//      ws-acp-client, and the file's content must show up in the
//      assistant bubble,
//   3. cancel — send a long-form prompt, wait for `streaming`,
//      click the cancel button, and assert the chat returns to a
//      terminal post-streaming state (idle or error).
//
// Everything is driven through the UI; filesystem prep happens via
// Node `fs` directly against the agent's cwd because that's the
// e2e seam the user sees ("the file already exists in the working
// directory").
//
// The journey uses gpt-5.4-mini (provisioned in global-setup) and
// makes ~5-6 LLM calls. Total runtime is ~60-90s; keep the global
// timeout headroom in mind when iterating locally.
test.describe('acp-ui ↔ ws-acp-client sessions + tools journey', () => {
  // Phase 6: agent-driven sessions persist across the suite, so this
  // spec spawns its own ws-acp-client to keep `expectCount(N)`
  // assertions deterministic (the global-setup ws-acp-client is shared
  // by simpler specs).
  const ws = createPerSpecWsServer();
  test.beforeAll(async () => {
    await ws.start();
  });
  test.afterAll(async () => {
    await ws.stop();
  });

  test('multi-session + tool + cancel', async ({ page }) => {
    const state = getTestState();
    const auth = new AuthPage(page);
    const settings = new SettingsPage(page);
    const chat = new ChatPage(page);
    const sessions = new SessionsView(page);

    const SENTINEL_A = 'WORDA42';
    const SENTINEL_B = 'WORDB99';
    const HELLO_BEACON = 'PHASE4_TOOL_BEACON_X92';
    const AGENT_NAME = 'E2E-WS-TOOLS';

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

    await test.step('Session A: open + first prompt → idle, sentinel visible', async () => {
      await chat.newSession();
      await chat.expectState('ready');
      await chat.selectModel(state.modelId);
      await chat.send(`Respond with the marker ${SENTINEL_A} and nothing else.`);
      await chat.expectState('idle');
      await expect(chat.bubble(1, 'assistant')).toContainText(SENTINEL_A, {
        ignoreCase: true,
      });
    });

    await test.step('Sidebar lists session A', async () => {
      await sessions.expectCount(1);
    });

    await test.step('Disconnect, open Session B with a different prompt', async () => {
      await page.locator('[data-testid="btn-disconnect"]').click();
      await chat.expectState('disconnected');
      await chat.newSession();
      await chat.expectState('ready');
      await chat.selectModel(state.modelId);
      await chat.send(`Respond with the marker ${SENTINEL_B} and nothing else.`);
      await chat.expectState('idle');
      await expect(chat.bubble(1, 'assistant')).toContainText(SENTINEL_B, {
        ignoreCase: true,
      });
    });

    await test.step('Sidebar lists both sessions; B is most recent', async () => {
      await sessions.expectCount(2);
      // The list is sorted by lastUpdated DESC: row 0 is the most recent
      // session (B), row 1 is the older one (A). Soft-assert the agent
      // attribute as a sanity check; the hard count assert above is the
      // primary signal.
      await expect.soft(sessions.rows().nth(0)).toHaveAttribute(
        'data-test-agent',
        AGENT_NAME
      );
      await expect.soft(sessions.rows().nth(1)).toHaveAttribute(
        'data-test-agent',
        AGENT_NAME
      );
    });

    await test.step('Click session A — transcript replays + sentinel visible', async () => {
      // Row index 1 in the DESC-sorted list is the older session A.
      await sessions.rows().nth(1).click();
      await chat.expectState('idle');
      // The agent's loadSession only re-emits stored notifications,
      // and `@bodhiapp/web-acp-agent` does not record
      // `user_message_chunk` rows during prompt() — the user-side
      // bubble lives only in the live-session UI state. So after a
      // resume there's exactly one bubble per assistant turn. Match
      // by role rather than index to stay forward-compatible if the
      // agent starts replaying user_message_chunks.
      await expect(
        page.locator('[data-test-role="assistant"]').first()
      ).toContainText(SENTINEL_A, { ignoreCase: true });
    });

    await test.step('Tool prompt: agent reads pre-seeded hello.txt via bash', async () => {
      // Pre-seed the agent's cwd with a deterministic beacon. The
      // ws-acp-client mounts $cwd at /mnt/cwd via PassthroughFS.
      await mkdir(ws.cwd, { recursive: true });
      await writeFile(join(ws.cwd, 'hello.txt'), `${HELLO_BEACON}\n`, 'utf8');

      await chat.send(
        `Use the bash tool to read the file /mnt/cwd/hello.txt and output its exact contents.`
      );
      await chat.expectState('idle');
      // The assistant either echoes the file contents inline or
      // includes them in a tool-call summary; either way the beacon
      // must appear somewhere in the message bubbles.
      await expect(chat.messages.last()).toContainText(HELLO_BEACON);
    });

    await test.step('Cancel: long prompt → streaming → cancel → terminal state', async () => {
      await chat.send('Write a 1000-word essay about the history of typewriters.');
      // Wait for the chat surface to enter `streaming` before clicking
      // cancel. The model usually takes a few seconds to start emitting
      // tokens after `prompt()`, so waiting on the data-test-state
      // attribute is the right hook.
      await chat.expectState('streaming');
      await chat.cancelButton.click();
      // Cancellation drives `isLoading` back to false; the chat surface
      // returns to `idle` (cancellation isn't an error in acp-ui's
      // current state machine — the message stream simply halts).
      await chat.expectState('idle');
    });
  });
});
