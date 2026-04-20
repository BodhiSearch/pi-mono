import { test, expect } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

test.describe('M7 — Manual compaction', () => {
  test('compact button triggers compaction and surfaces a summary bubble', async ({ page }) => {
    test.setTimeout(90_000);
    const { username, password, bodhiServerUrl } = getTestState();

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    await test.step('build a multi-turn conversation', async () => {
      await chat.send('what day comes after monday? answer in one word');
      await chat.waitForAssistantTurn(0);
      await chat.send('what month comes after january? answer in one word');
      await chat.waitForAssistantTurn(1);
    });

    await test.step('trigger manual compaction', async () => {
      await chat.compactNow();
    });

    await test.step('verify the compaction summary bubble is visible', async () => {
      const summary = chat.compactionSummary();
      await expect(summary).toBeVisible();
      await expect(summary).toHaveAttribute('data-kind', 'compaction-summary');
      const tokensBefore = await summary.getAttribute('data-tokens-before');
      expect(tokensBefore).toBeTruthy();
      expect(Number(tokensBefore)).toBeGreaterThan(0);
    });

    await test.step('session still works after compaction', async () => {
      await chat.send('what is 2 + 2? answer in one word');
      await chat.waitForStreamingDone();
      const reply = (await chat.lastAssistantText()).toLowerCase();
      expect(reply).toMatch(/4|four/);
    });
  });
});
