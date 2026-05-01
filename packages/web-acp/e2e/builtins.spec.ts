import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

test.describe('built-in slash commands', () => {
  test.setTimeout(120_000);

  test('built-ins render muted with a badge, /copy writes markdown, /copy without an LLM turn warns, and reload preserves the bubbles', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { username, password, bodhiServerUrl } = getTestState();

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    await test.step('typing `/` shows the built-ins in the picker alongside vault commands', async () => {
      const input = page.locator('[data-testid="chat-input"]');
      await input.fill('/');
      await page
        .locator('[data-testid="command-picker"][data-test-state="open"]')
        .waitFor({ timeout: 10_000 });
      await expect(page.locator('[data-testid="command-picker-item-help"]')).toBeVisible();
      await expect(page.locator('[data-testid="command-picker-item-version"]')).toBeVisible();
      await expect(page.locator('[data-testid="command-picker-item-session"]')).toBeVisible();
      await expect(page.locator('[data-testid="command-picker-item-copy"]')).toBeVisible();
      await input.fill('');
    });

    await test.step('/copy before any assistant turn surfaces "nothing to copy" both in transcript and toast', async () => {
      await chat.send('/copy');
      // Built-in reply lands as the assistant bubble of turn 0.
      const reply = page.locator(
        '[data-testid="chat-message-turn-0"][data-messagetype="assistant"]'
      );
      await reply.waitFor();
      await expect(reply).toHaveAttribute('data-test-state', 'builtin');
      await expect(reply).toContainText(/nothing to copy/i);
      // Toast surfaces the no-op warning to the user.
      await expect(page.locator('text=Nothing to copy yet').first()).toBeVisible({
        timeout: 5_000,
      });
    });

    await test.step('/help renders muted with the "not sent to LLM" badge', async () => {
      await chat.send('/help');
      const userBubble = page
        .locator('[data-testid="chat-message-turn-1"][data-messagetype="user"]')
        .first();
      await userBubble.waitFor();
      await expect(userBubble).toHaveAttribute('data-test-state', 'builtin');
      const replyBubble = page
        .locator('[data-testid="chat-message-turn-1"][data-messagetype="assistant"]')
        .first();
      await replyBubble.waitFor();
      await expect(replyBubble).toHaveAttribute('data-test-state', 'builtin');
      await expect(replyBubble).toContainText('/help');
      await expect(replyBubble).toContainText('/copy');
      await expect(replyBubble.locator('[data-testid="builtin-badge"]')).toContainText(
        /not sent to LLM/i
      );
    });

    let realReplyText = '';
    await test.step('a real prompt produces a non-built-in assistant turn', async () => {
      await chat.send('Reply with exactly the following text and nothing else: BODHI-COPY-OK');
      await chat.waitForAssistantTurn(2);
      const last = page.locator(
        '[data-testid="chat-message-turn-2"][data-messagetype="assistant"]'
      );
      await expect(last).not.toHaveAttribute('data-test-state', 'builtin');
      realReplyText = (await last.textContent()) ?? '';
      expect(realReplyText).toContain('BODHI-COPY-OK');
    });

    await test.step('/copy writes the conversation markdown to the clipboard and toasts success', async () => {
      await chat.send('/copy');
      const reply = page
        .locator('[data-testid="chat-message-turn-3"][data-messagetype="assistant"]')
        .first();
      await reply.waitFor();
      await expect(reply).toHaveAttribute('data-test-state', 'builtin');
      await expect(reply).toContainText(/copied/i);
      await expect(page.locator('text=Copied conversation to clipboard').first()).toBeVisible({
        timeout: 5_000,
      });
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      // Built-ins (/help, /copy) must NOT appear in the copied markdown —
      // only the real user/assistant exchange.
      expect(clipboard).toContain('BODHI-COPY-OK');
      expect(clipboard).toContain('**Assistant:**');
      expect(clipboard).toContain('**You:**');
      expect(clipboard).not.toContain('/help');
      expect(clipboard).not.toContain('/copy');
    });

    await test.step('reloading the page restores both built-in bubbles still tagged', async () => {
      await page.reload();
      await chat.waitServerReady(bodhiServerUrl);
      await page.locator('[data-testid="section-auth"][data-test-state="authenticated"]').waitFor();
      await chat.waitForSessionCount(1);
      const [sessionId] = await chat.listSessionIds();
      await chat.clickSession(sessionId);
      // The /help reply is the second built-in pair (turn 1 in our flow).
      const reply = page
        .locator('[data-testid="chat-message-turn-1"][data-messagetype="assistant"]')
        .first();
      await reply.waitFor({ timeout: 10_000 });
      await expect(reply).toHaveAttribute('data-test-state', 'builtin');
      await expect(reply).toContainText('/help');
    });
  });
});
