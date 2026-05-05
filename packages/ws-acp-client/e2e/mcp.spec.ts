import { expect, test } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { McpPanelComponent } from './pages/McpPanelComponent';
import { SettingsPage } from './pages/SettingsPage';
import { getTestState } from './global-setup';
import { createPerSpecWsServer } from './utils/per-spec-ws';

// Phase 10 gate. Mirrors `packages/web-acp/e2e/mcp.spec.ts` against
// the ws-acp-client + acp-ui stack:
//
//   1. Cold-login WITHOUT MCP scopes → `mcp-panel-empty`.
//   2. `/mcp` empty → muted reply, "No MCP servers requested".
//   3. `/mcp add <url>` → muted reply with "Re-authenticating",
//      then the dispatched action triggers logout + login(opts) and
//      the browser bounces through `/access-requests/review` (toggle
//      on for the requested URL) → returns to localhost.
//   4. Re-select agent + cwd + new session → MCP panel shows the
//      seeded `everything` instance as `connected` with reference
//      tools, panel `data-test-state="1"` (one connected server).
//   5. Forced echo prompt with `forceToolCall=on` → model calls
//      `everything__echo`, the beacon surfaces in the transcript.
//   6. `/mcp` lists Connected → `/mcp add <same-url>` is idempotent
//      ("already in your requested list", URL stays on the app).
//   7. `/mcp remove <url>` → muted "Removing" reply, re-auth chain
//      with empty scopes → return → reconnect → panel empties.
//
// 1 LLM call, 2 OAuth round-trips. ~60-90s on a warm laptop.
test.describe('acp-ui ↔ ws-acp-client MCP add/remove via /mcp', () => {
  // Per-spec ws-acp-client so the agent's MCP pool starts empty and
  // sqlite is fresh — re-auth + reconnect flips MCP state through
  // multiple session lifecycles in this test, and we don't want to
  // collide with sessions/features sibling specs.
  const ws = createPerSpecWsServer();

  test.beforeAll(async () => {
    await ws.start();
  });
  test.afterAll(async () => {
    await ws.stop();
  });

  test('add via /mcp re-auth, server connects, echo roundtrip, list, idempotency, remove', async ({
    page,
  }) => {
    const state = getTestState();
    const auth = new AuthPage(page);
    const settings = new SettingsPage(page);
    const chat = new ChatPage(page);
    const mcp = new McpPanelComponent(page);

    const AGENT_NAME = 'E2E-WS-MCP';
    const slug = state.mcpEverythingSlug;
    const everythingUrl = state.mcpEverythingUrl;
    const echoToken = `WS_ACP_MCP_ECHO_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

    await test.step('Setup: login WITHOUT MCP scopes, configure server, add WS agent', async () => {
      await page.goto('/');
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();

      await settings.open();
      await settings.setBodhiServerUrl(state.bodhiServerUrl);
      await settings.close();

      // Cold login with `acceptMcps: []` → no MCP scopes approved.
      // Bodhi-side instance catalog is therefore empty for this user
      // until the `/mcp add` re-auth flow flips it on.
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

    await test.step('New session — MCP panel renders empty (zero approved instances)', async () => {
      await chat.newSession();
      await chat.expectState('ready');
      await chat.selectModel(state.modelId);

      await expect(page.locator('[data-testid="mcp-panel-empty"]')).toBeVisible();
      await expect(mcp.panel).toHaveAttribute('data-test-state', '0');
      await mcp.expectAbsent(slug);
    });

    await test.step('/mcp on empty list → muted pair, "No MCP servers requested yet"', async () => {
      await chat.send('/mcp');
      await chat.expectState('idle');
      await expect(chat.bubble(0, 'user')).toHaveAttribute('data-test-builtin', 'mcp');
      await expect(chat.bubble(1, 'assistant')).toHaveAttribute('data-test-builtin', 'mcp');
      await expect(chat.bubbleContent(1, 'assistant')).toContainText(/No MCP servers requested/i);
    });

    await test.step('/mcp add <url> emits "Re-authenticating" reply and triggers re-auth bounce', async () => {
      await chat.send(`/mcp add ${everythingUrl}`);
      // The agent emits the muted assistant chunk with the
      // "Re-authenticating to add ..." text BEFORE the action handler
      // runs the bodhi logout + redirect. Wait for the bubble to
      // settle so the assertion isn't racing the navigation.
      const reply = chat.bubble(3, 'assistant');
      await reply.waitFor();
      await expect(reply).toHaveAttribute('data-test-builtin', 'mcp');
      await expect(chat.bubbleContent(3, 'assistant')).toContainText(/Re-authenticating/i);

      // Action handler now drives the redirect. The browser lands on
      // BodhiApp's access-request review page; we approve with the
      // requested URL toggled on. SSO short-circuits the password
      // prompt because we logged in already this test.
      await page.waitForURL(/\/access-requests\/review/);
      await auth.reauthForMcpChange([everythingUrl]);
    });

    await test.step('Reconnect — MCP panel renders the everything server connected with tools', async () => {
      // Post-redirect we're back on `localhost:5173/` with a fresh
      // SPA mount: bridge is gone, sidebar empty, currentSession null.
      // Re-select agent + cwd + new session; the new session's
      // `_meta.bodhi.{requestedMcpUrls,mcpInstances}` carries the
      // newly approved everything instance and the agent fires a
      // `_bodhi/mcp/state` notification on pool acquire.
      await chat.expectState('disconnected');
      await chat.selectAgent(AGENT_NAME);
      await chat.setCwd(ws.cwd);
      await chat.newSession();
      await chat.expectState('ready');
      await chat.selectModel(state.modelId);

      await mcp.expectServerState(slug, 'connected');
      await mcp.expectToolVisible(slug, 'echo');
      await expect.soft(mcp.panel).toHaveAttribute('data-test-state', '1');
    });

    await test.step('Forced echo prompt — model calls everything__echo and surfaces the token', async () => {
      // Turn forceToolCall on so the OpenAI model deterministically
      // chooses a tool. We don't toggle bashEnabled — only the MCP
      // tool needs to fire for this assertion.
      await page.locator('[data-testid="feature-toggle-forceToolCall"]').click();
      await expect(
        page.locator('[data-testid="feature-row-forceToolCall"]')
      ).toHaveAttribute('data-test-state', 'on');

      const toolName = `${slug}__echo`;
      await chat.send(
        `Call the ${toolName} tool with {"message":"${echoToken}"} and then reply with exactly the echoed text.`
      );
      await chat.expectState('idle');
      // The beacon must surface either in the assistant text or in a
      // tool-call card; assert against the trailing transcript.
      await expect(chat.messages.last()).toContainText(echoToken);
    });

    await test.step('/mcp lists Connected after add', async () => {
      await chat.send('/mcp');
      await chat.expectState('idle');
      // After the previous LLM turn, the next user/assistant pair
      // lands at indices 4 (forceToolCall prompt user) + 5 (assistant
      // tool reply); the /mcp pair lands at 6 + 7. Match by tag
      // rather than absolute index to keep the assertion stable
      // across upstream prompt/response shape changes.
      const reply = page.locator('[data-test-role="assistant"][data-test-builtin="mcp"]').last();
      await expect(reply).toBeVisible();
      await expect.soft(reply).toContainText(/Connected/i);
      await expect.soft(reply).toContainText(everythingUrl);
    });

    await test.step('/mcp add <same-url> is idempotent — info reply, no re-auth bounce', async () => {
      await chat.send(`/mcp add ${everythingUrl}`);
      await chat.expectState('idle');
      const reply = page.locator('[data-test-role="assistant"][data-test-builtin="mcp"]').last();
      await expect(reply).toContainText(/already in your requested list/i);
      // No `/access-requests` bounce — we're still on the SPA.
      expect(page.url()).toContain('localhost:5173');
    });

    await test.step('/mcp remove <url> drops the server and re-auths with the reduced scope', async () => {
      await chat.send(`/mcp remove ${everythingUrl}`);
      const reply = page.locator('[data-test-role="assistant"][data-test-builtin="mcp"]').last();
      await reply.waitFor();
      await expect(reply).toContainText(/Removing/i);

      await page.waitForURL(/\/access-requests\/review/);
      await auth.reauthForMcpChange([]);

      // Reconnect to verify the agent's MCP pool released the server.
      await chat.expectState('disconnected');
      await chat.selectAgent(AGENT_NAME);
      await chat.setCwd(ws.cwd);
      await chat.newSession();
      await chat.expectState('ready');

      await mcp.expectAbsent(slug);
      await expect(mcp.panel).toHaveAttribute('data-test-state', '0');
    });
  });
});
