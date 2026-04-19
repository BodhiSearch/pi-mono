import { test, expect } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

test.describe('Demo Chat Application', () => {
  test('chat answers what day comes after monday with tuesday', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);
    await chat.send('what day comes after monday? answer in one word');
    await chat.waitForAssistantTurn(0);

    const reply = await chat.getAssistantText(0);
    expect(reply.toLowerCase()).toContain('tuesday');
  });
});
