import { test, expect } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

test.describe('ACP session persistence', () => {
  test('session survives page reload and shows in picker', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    await chat.send('what day comes after monday? answer in one word');
    await chat.waitForAssistantTurn(0);

    // One session should now be persisted.
    await chat.waitForSessionCount(1);
    const beforeReload = await chat.listSessionIds();
    expect(beforeReload).toHaveLength(1);

    const [sessionId] = beforeReload;
    const titleBefore = await chat.getSessionTitle(sessionId);
    expect(titleBefore.toLowerCase()).toContain('monday');

    // Reload — worker + IndexedDB must rehydrate the same session row.
    await page.reload();
    await chat.waitServerReady(bodhiServerUrl);
    // Auth is carried by Bodhi's stored tokens; no login needed.
    await page.locator('[data-testid="section-auth"][data-test-state="authenticated"]').waitFor();

    await chat.waitForSessionCount(1);
    const afterReload = await chat.listSessionIds();
    expect(afterReload).toEqual(beforeReload);

    const titleAfter = await chat.getSessionTitle(sessionId);
    expect(titleAfter).toBe(titleBefore);
  });
});
