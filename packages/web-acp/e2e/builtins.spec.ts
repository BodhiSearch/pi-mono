import { test, expect } from './tests/fixtures';
import { appReady, appReloadReady } from './tests/flows';
import { FULL_MODEL_ID } from './tests/global-setup';

test.describe('built-ins', () => {
  test('picker advertisement, /copy no-op + success, /help, /version, /info, /mcp list, reload tagging', async ({
    page,
    context,
    setup,
    status,
    auth,
    chat,
    messages,
    sessions,
    picker,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await test.step('setup — boot, authenticate, pick OpenAI model', async () => {
      await appReady({ page, setup, status, auth, chat }, { selectModel: FULL_MODEL_ID });
    });

    await test.step('typing `/` advertises every built-in in the picker', async () => {
      await chat.fillRaw('/');
      await picker.expectOpen();
      await expect.soft(picker.item('help')).toBeVisible();
      await expect.soft(picker.item('version')).toBeVisible();
      await expect.soft(picker.item('info')).toBeVisible();
      await expect.soft(picker.item('copy')).toBeVisible();
      await expect.soft(picker.item('mcp')).toBeVisible();
      await chat.fillRaw('');
    });

    await test.step('/copy with no LLM turn — built-in reply + warning toast', async () => {
      await chat.send('/copy');
      const reply = messages.bubble(0, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(0, 'assistant');
      await expect(reply).toContainText(/nothing to copy/i);
      await expect(page.locator('text=Nothing to copy yet').first()).toBeVisible();
    });

    await test.step('/help renders muted with the "not sent to LLM" badge and lists every built-in', async () => {
      await chat.send('/help');
      await messages.bubble(1, 'user').waitFor();
      await messages.expectBuiltin(1, 'user');
      const reply = messages.bubble(1, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(1, 'assistant');
      await messages.expectBuiltinBadge(1);
      await expect.soft(reply).toContainText('/help');
      await expect.soft(reply).toContainText('/version');
      await expect.soft(reply).toContainText('/info');
      await expect.soft(reply).toContainText('/copy');
      await expect.soft(reply).toContainText('/mcp');
    });

    await test.step('/version reply contains the web-acp build identifier', async () => {
      await chat.send('/version');
      const reply = messages.bubble(2, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(2, 'assistant');
      await expect(reply).toContainText(/web-acp:/);
    });

    await test.step('/info reply describes the active session', async () => {
      await chat.send('/info');
      const reply = messages.bubble(3, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(3, 'assistant');
      await expect.soft(reply).toContainText(/Session/i);
      await expect.soft(reply).toContainText('Turns');
      await expect.soft(reply).toContainText(FULL_MODEL_ID);
      await expect.soft(reply).toContainText(/MCP servers/i);
    });

    await test.step('/mcp (empty list) — built-in reply names the empty state', async () => {
      await chat.send('/mcp');
      const reply = messages.bubble(4, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(4, 'assistant');
      await expect(reply).toContainText(/No MCP servers requested yet/i);
    });

    await test.step('a real prompt produces a non-built-in assistant turn', async () => {
      await chat.send('Reply with exactly the following text and nothing else: BODHI-COPY-OK');
      const reply = messages.bubble(5, 'assistant');
      await expect(reply).toContainText('BODHI-COPY-OK');
      await messages.expectNotBuiltin(5, 'assistant');
    });

    await test.step('/copy writes the LLM-only conversation as markdown to the clipboard', async () => {
      await chat.send('/copy');
      const reply = messages.bubble(6, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(6, 'assistant');
      await expect(reply).toContainText(/copied/i);
      await expect(page.locator('text=Copied conversation to clipboard').first()).toBeVisible();
      const clipboard = await messages.readClipboard();
      expect.soft(clipboard).toContain('BODHI-COPY-OK');
      expect.soft(clipboard).toContain('**Assistant:**');
      expect.soft(clipboard).toContain('**You:**');
      expect.soft(clipboard).not.toContain('/help');
      expect.soft(clipboard).not.toContain('/copy');
      expect.soft(clipboard).not.toContain('/version');
    });

    let persistedSessionId = '';

    await test.step('capture the persisted session id before reload', async () => {
      const ids = await sessions.listIds();
      // Only one persisted session exists in this test; the auto-empty
      // (if any) sits alongside but our session is the one with turns.
      persistedSessionId = ids[0] ?? '';
      expect(persistedSessionId).toBeTruthy();
    });

    await test.step('reload — built-in bubbles still tagged after rehydration', async () => {
      await page.reload();
      await appReloadReady({ page, setup, status });
      // Wait for the persisted session row to materialise, then click
      // it before the auto-create useEffect (currentSessionId == null
      // on mount) can race in the background.
      await sessions.row(persistedSessionId).waitFor();
      await sessions.click(persistedSessionId);
      // /help was turn 1 in this session; the bubble should still be muted.
      const reply = messages.bubble(1, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(1, 'assistant');
      await expect(reply).toContainText('/help');
    });
  });
});
