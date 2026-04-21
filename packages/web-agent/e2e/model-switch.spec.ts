import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { SessionPage } from './tests/pages/SessionPage';
import { FULL_MODEL_ID, SECOND_FULL_MODEL_ID, getTestState } from './tests/global-setup';

test.describe('Model switching — fork + provider swap', () => {
  test('selected model persists per-branch across fork and reload', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();
    const chat = new ChatPage(page);
    const sessions = new SessionPage(page);

    await test.step('load app, authenticate, pick OpenAI model', async () => {
      await page.goto('/');
      await chat.waitServerReady(bodhiServerUrl);
      await chat.login({ username, password });
      await chat.loadModels();
      await chat.selectModel(FULL_MODEL_ID);
    });

    await test.step('ask a factual question — expect "tuesday"', async () => {
      await chat.send('what day comes after monday? answer in one word');
      await chat.waitForAssistantTurn(0);
      const reply = await chat.getAssistantText(0);
      expect(reply.toLowerCase()).toContain('tuesday');
    });

    await test.step('ask who trained you — expect OpenAI', async () => {
      await chat.send('who trained you? answer in one short sentence');
      await chat.waitForAssistantTurn(1);
      // LLM phrasing is non-deterministic; match provider name loosely.
      const reply = await chat.getAssistantText(1);
      expect(reply).toMatch(/openai/i);
    });

    const parentSessionId = await test.step('record the active session id', async () => {
      const id = await sessions.currentSessionId();
      if (!id) throw new Error('no active session id');
      return id;
    });

    const forkEntryId = await test.step('capture the turn-0 assistant entry id', async () => {
      await expect
        .poll(async () => (await sessions.messageEntryIds()).length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(2);
      const assistantBubble = page
        .locator('[data-testid="chat-message-turn-0"][data-messagetype="assistant"]')
        .first();
      const id = await assistantBubble.getAttribute('data-entry-id');
      expect(id).toBeTruthy();
      return id as string;
    });

    let forkedSessionId = '';
    await test.step('fork from turn-0 assistant — new session lands with one turn', async () => {
      await sessions.forkFromEntry(forkEntryId);
      await expect
        .poll(async () => sessions.currentSessionId(), { timeout: 10_000 })
        .not.toBe(parentSessionId);
      const id = await sessions.currentSessionId();
      if (!id) throw new Error('fork did not land');
      forkedSessionId = id;
      // Fork copy: turn 0 (user "monday" + assistant "tuesday") present,
      // turn 1 (the OpenAI question) is cut.
      await page.locator('[data-testid="chat-message-turn-0"][data-messagetype="user"]').waitFor();
      await expect(
        page.locator('[data-testid="chat-message-turn-1"][data-messagetype="assistant"]')
      ).toHaveCount(0);
    });

    await test.step('switch model to Gemini on the fork', async () => {
      await chat.selectModel(SECOND_FULL_MODEL_ID);
    });

    await test.step('ask who trained you on the Gemini branch — expect Google/Gemini', async () => {
      await chat.send('who trained you? answer in one short sentence');
      // Turn count on the fork: turn 0 inherited, turn 1 is the new Q.
      await chat.waitForAssistantTurn(1);
      const reply = await chat.getAssistantText(1);
      expect(reply).toMatch(/google|gemini/i);
    });

    await test.step('reload — fork is still active and Gemini is still the selected model', async () => {
      await page.reload();
      await chat.waitServerReady(bodhiServerUrl);
      const restoredId = await sessions.waitForActiveSession();
      expect(restoredId).toBe(forkedSessionId);
      // Model-selector trigger text reflects the persisted model_change
      // on this branch. Proves the Worker's restore path + the
      // main-thread `getState` sync.
      await expect(page.locator(chat.selectors.modelSelector)).toContainText(SECOND_FULL_MODEL_ID);
    });

    await test.step('switching back to the OpenAI branch restores OpenAI selection', async () => {
      await sessions.switchTo(parentSessionId);
      await expect
        .poll(async () => sessions.currentSessionId(), { timeout: 10_000 })
        .toBe(parentSessionId);
      await expect(page.locator(chat.selectors.modelSelector)).toContainText(FULL_MODEL_ID);
    });
  });
});
