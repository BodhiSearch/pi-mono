import { expect, test } from '@playwright/test';
import { installVault } from './helpers/install-vault';
import { ChatPage } from './tests/pages/ChatPage';
import { SessionPage } from './tests/pages/SessionPage';
import { VaultPage } from './tests/pages/VaultPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

test.describe('Session persistence — M5', () => {
  test('messages survive reload; new/switch swaps session in place', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();
    const chat = new ChatPage(page);
    const vault = new VaultPage(page);
    const sessions = new SessionPage(page);

    await test.step('install seeded vault', async () => {
      await installVault(page, 'sample');
    });

    await test.step('load app, authenticate, and pick a model', async () => {
      await page.goto('/');
      await chat.waitServerReady(bodhiServerUrl);
      await vault.waitForMounted();
      await chat.login({ username, password });
      await chat.loadModels();
      await chat.selectModel(FULL_MODEL_ID);
    });

    const firstSessionId =
      await test.step('wait for a persisted session to be active', async () => {
        return sessions.waitForActiveSession();
      });

    await test.step('send a message and wait for the assistant reply', async () => {
      await chat.send('Reply with exactly one word: hello.');
      await chat.waitForAssistantTurn(0);
    });

    await test.step('picker lists the active session with the new messages', async () => {
      await sessions.open();
      const item = sessions.listItem(firstSessionId);
      await expect(item).toBeVisible();
      await expect(item).toContainText(/\bmsg\b/);
      // Close the popover so it doesn't cover UI for the next step.
      await page.keyboard.press('Escape');
      await expect(sessions.list).not.toBeVisible();
    });

    await test.step('reload — active session id is restored from localStorage', async () => {
      await page.reload();
      await chat.waitServerReady(bodhiServerUrl);
      await vault.waitForMounted();
      const restoredId = await sessions.waitForActiveSession();
      expect(restoredId).toBe(firstSessionId);
    });

    await test.step('the user + assistant messages from the previous turn re-render', async () => {
      await page.locator('[data-testid^="chat-message-turn-0"]').first().waitFor();
      const firstBubble = page
        .locator('[data-testid="chat-message-turn-0"][data-messagetype="user"]')
        .first();
      await expect(firstBubble).toContainText('hello');
    });

    const secondSessionId = await test.step('create a new session — messages clear', async () => {
      await sessions.newSession();
      await expect
        .poll(async () => sessions.currentSessionId(), { timeout: 10_000 })
        .not.toBe(firstSessionId);
      await expect(page.locator('[data-testid="chat-message-turn-0"]')).toHaveCount(0);
      const id = await sessions.currentSessionId();
      if (!id) throw new Error('no active session after newSession');
      return id;
    });

    await test.step('switching back to the original session restores its messages', async () => {
      await sessions.switchTo(firstSessionId);
      await expect
        .poll(async () => sessions.currentSessionId(), { timeout: 10_000 })
        .toBe(firstSessionId);
      const firstBubble = page
        .locator('[data-testid="chat-message-turn-0"][data-messagetype="user"]')
        .first();
      await expect(firstBubble).toContainText('hello');
    });

    await test.step('new session is still deletable from the picker', async () => {
      await sessions.deleteSession(secondSessionId);
      // Picker stays open after delete; pressing Escape closes it.
      await page.keyboard.press('Escape');
      await expect(sessions.list).not.toBeVisible();
      await sessions.open();
      await expect(sessions.listItem(secondSessionId)).toHaveCount(0);
      await page.keyboard.press('Escape');
    });
  });
});
