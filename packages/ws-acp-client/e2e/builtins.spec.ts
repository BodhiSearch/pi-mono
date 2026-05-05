import { expect, test } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { SessionsView } from './pages/SessionsView';
import { SettingsPage } from './pages/SettingsPage';
import { getTestState } from './global-setup';
import { createPerSpecWsServer } from './utils/per-spec-ws';

// Phase 5 gate. Drives the agent's built-in slash command surface
// end-to-end through the post-refactor `web-acp-agent` wire:
//
//   1. `/` palette advertises every built-in (`copy`, `help`, `info`,
//      `mcp`, `version`).
//   2. `/copy` on an empty conversation produces a muted, badged
//      bubble pair AND no clipboard write (nothing to copy yet).
//   3. `/help`, `/version`, `/info`, `/mcp` each render muted+badged
//      pairs with shape-sensitive content (no exact prose match;
//      command-specific keywords keep the gate stable across copy
//      tweaks).
//   4. A real LLM turn lands as a normal (non-muted) bubble.
//   5. `/copy` after the LLM turn writes a `**You:** … **Assistant:**`
//      markdown transcript to the system clipboard.
//   6. After page reload + clicking the saved session row, the
//      `_meta.bodhi.messages` reconstruction restores the muted
//      `/help` bubble (built-in tagging survives rehydration —
//      validates that we read the agent's authoritative inline
//      transcript on `loadSession`, not just the notification
//      replay stream which omits built-in pairs).
//
// Built-ins do not call the LLM, so this journey makes a single
// model-backed prompt round-trip (~1 LLM call). Total runtime on
// a warm laptop is ~30-45s.
test.describe('acp-ui ↔ ws-acp-client built-in slash commands', () => {
  // Phase 6: agent-driven sessions persist in sqlite across the suite,
  // and this spec asserts `expectCount(1)` after a reload — so we need
  // a dedicated ws-acp-client process with a fresh state.db.
  const ws = createPerSpecWsServer();
  test.beforeAll(async () => {
    await ws.start();
  });
  test.afterAll(async () => {
    await ws.stop();
  });

  test('palette + tagged bubbles + /copy clipboard + reload preserves tag', async ({ page, context }) => {
    const state = getTestState();
    const auth = new AuthPage(page);
    const settings = new SettingsPage(page);
    const chat = new ChatPage(page);
    const sessions = new SessionsView(page);

    const SENTINEL = 'BUILTIN42';
    const AGENT_NAME = 'E2E-WS-BUILTINS';

    // The /copy clipboard write requires a permission grant in headless
    // Chromium. Granted at context level so subsequent navigations also
    // have access without re-prompting.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

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

    await test.step('New session — palette advertises every built-in', async () => {
      await chat.newSession();
      await chat.expectState('ready');
      await chat.selectModel(state.modelId);

      // Open the slash palette by typing "/" — the picker is rendered
      // by `CommandPalette.vue` whenever the input starts with "/" and
      // there is no whitespace yet. We assert each built-in name is
      // present; the picker shape (one row per command) is enforced
      // implicitly by the locators succeeding.
      await chat.promptInput.fill('/');
      const palette = page.locator('.command-palette');
      await expect(palette).toBeVisible();
      for (const name of ['copy', 'help', 'info', 'mcp', 'version']) {
        await expect.soft(palette.getByText(`/${name}`, { exact: true })).toBeVisible();
      }
      // Clear the input so the next step starts from a known state.
      await chat.promptInput.fill('');
    });

    await test.step('/copy on empty conversation → muted pair, "Nothing to copy yet"', async () => {
      await chat.send('/copy');
      // The agent emits exactly one tagged `agent_message_chunk`; the
      // store also tags the user bubble we just pushed.
      await chat.expectState('idle');
      await expect(chat.bubble(0, 'user')).toHaveAttribute('data-test-builtin', 'copy');
      await expect(chat.bubble(1, 'assistant')).toHaveAttribute('data-test-builtin', 'copy');
      // Both halves render the badge; soft-asserted so a missing badge
      // doesn't short-circuit the rest of the journey.
      const userBadge = chat.bubble(0, 'user').locator('[data-test-builtin-badge]');
      const asstBadge = chat.bubble(1, 'assistant').locator('[data-test-builtin-badge]');
      await expect.soft(userBadge).toBeVisible();
      await expect.soft(asstBadge).toBeVisible();
      await expect(chat.bubbleContent(1, 'assistant')).toContainText('Nothing to copy yet');
    });

    await test.step('/help → muted pair, lists every advertised command', async () => {
      await chat.send('/help');
      await chat.expectState('idle');
      await expect(chat.bubble(2, 'user')).toHaveAttribute('data-test-builtin', 'help');
      await expect(chat.bubble(3, 'assistant')).toHaveAttribute('data-test-builtin', 'help');
      // The agent's `/help` reply enumerates each built-in. Use a
      // stable substring (the leading `**Available commands**` heading)
      // plus a single command name as a sanity check.
      await expect(chat.bubbleContent(3, 'assistant')).toContainText('Available commands');
      await expect(chat.bubbleContent(3, 'assistant')).toContainText('/version');
    });

    await test.step('/version → muted pair, mentions web-acp + ACP SDK', async () => {
      await chat.send('/version');
      await chat.expectState('idle');
      await expect(chat.bubble(4, 'user')).toHaveAttribute('data-test-builtin', 'version');
      await expect(chat.bubble(5, 'assistant')).toHaveAttribute('data-test-builtin', 'version');
      await expect(chat.bubbleContent(5, 'assistant')).toContainText('web-acp');
      await expect(chat.bubbleContent(5, 'assistant')).toContainText('ACP SDK');
    });

    await test.step('/info → muted pair, surfaces session id + model', async () => {
      await chat.send('/info');
      await chat.expectState('idle');
      await expect(chat.bubble(6, 'user')).toHaveAttribute('data-test-builtin', 'info');
      await expect(chat.bubble(7, 'assistant')).toHaveAttribute('data-test-builtin', 'info');
      await expect(chat.bubbleContent(7, 'assistant')).toContainText('Session');
      await expect(chat.bubbleContent(7, 'assistant')).toContainText(state.modelId);
    });

    await test.step('/mcp → muted pair, lists no requested servers', async () => {
      await chat.send('/mcp');
      await chat.expectState('idle');
      await expect(chat.bubble(8, 'user')).toHaveAttribute('data-test-builtin', 'mcp');
      await expect(chat.bubble(9, 'assistant')).toHaveAttribute('data-test-builtin', 'mcp');
      // Phase 10 introduces the `mcpStore`; until then the agent reports
      // an empty requested-mcps list. Match a stable substring that the
      // agent's empty-state reply emits.
      await expect(chat.bubbleContent(9, 'assistant')).toContainText('MCP');
    });

    await test.step('Real LLM turn — normal (non-muted) bubble pair', async () => {
      await chat.send(`Reply with the marker ${SENTINEL} and nothing else.`);
      await chat.expectState('idle');
      // No `data-test-builtin` attribute on a real LLM turn.
      await expect(chat.bubble(10, 'user')).not.toHaveAttribute('data-test-builtin', /.+/);
      await expect(chat.bubble(11, 'assistant')).not.toHaveAttribute('data-test-builtin', /.+/);
      await expect(chat.bubble(11, 'assistant')).toContainText(SENTINEL, { ignoreCase: true });
    });

    await test.step('/copy after LLM turn → clipboard contains markdown transcript', async () => {
      await chat.send('/copy');
      await chat.expectState('idle');
      await expect(chat.bubble(13, 'assistant')).toHaveAttribute('data-test-builtin', 'copy');
      await expect(chat.bubbleContent(13, 'assistant')).toContainText('Copied conversation');

      // Read the system clipboard via Playwright's evaluate handle on
      // navigator.clipboard. Permission was granted at context-level
      // above so this resolves without a chromium prompt.
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toContain('**You:**');
      expect(clipboard).toContain('**Assistant:**');
      expect(clipboard).toContain(SENTINEL);
      // Built-in turns are excluded from the markdown transcript even
      // though they're rendered as bubbles — verify by absence of the
      // `Available commands` heading from `/help` and the `/copy`
      // command itself.
      expect(clipboard).not.toContain('Available commands');
      expect(clipboard).not.toContain('/copy');
    });

    await test.step('Reload + resume — built-in tag survives rehydration', async () => {
      // Reload the SPA. The WS bridge drops; bodhiAuth state survives
      // (localStorage), but the sidebar is blank until we reconnect
      // because the Phase 6 sessions list is agent-driven. To re-fetch
      // the saved row we open a throwaway new session on the same
      // agent + cwd; that connect populates the sidebar via
      // `Agent.unstable_listSessions`.
      await page.reload();
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();
      await chat.expectState('disconnected');

      await chat.selectAgent(AGENT_NAME);
      await chat.setCwd(ws.cwd);
      await chat.newSession();
      await chat.expectState('ready');
      // Sidebar now shows two rows: the just-created throwaway and
      // the original /help-tagged one.
      await sessions.expectCount(2);

      // Click the OLDER saved-session row (index 1 in DESC-sorted
      // order) → resumeSession → the agent emits the inline
      // `_meta.bodhi.messages` reconstruction which the store overlays
      // on top of the notification-replay stream.
      await sessions.rows().nth(1).click();
      await chat.expectState('idle');

      // After replay, the bubble indices are based on the agent's
      // authoritative reconstruction (built-in pairs included). The
      // `/help` exchange should land as a tagged user/assistant pair.
      // Match by `data-test-builtin="help"` rather than a hardcoded
      // index so the gate stays stable if the agent later reorders
      // entries or compacts duplicates.
      const helpUser = page.locator('[data-test-role="user"][data-test-builtin="help"]');
      const helpAssistant = page.locator('[data-test-role="assistant"][data-test-builtin="help"]');
      await expect(helpUser).toBeVisible();
      await expect(helpAssistant).toBeVisible();
      await expect(helpAssistant).toContainText('Available commands');
      await expect(helpAssistant.locator('[data-test-builtin-badge]')).toBeVisible();
    });
  });
});
