import { test, expect } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

test.describe('ACP session delete', () => {
  test('delete inactive then active session via _bodhi/sessions/delete', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    // Two persisted sessions — first becomes "older", second becomes
    // active after `newChat` + send.
    await test.step('create two sessions', async () => {
      await chat.send('session A: reply with the single word alpha');
      await chat.waitForAssistantTurn(0);
      await chat.waitForSessionCount(1);
      const [sessionA] = await chat.listSessionIds();
      expect(sessionA).toBeTruthy();

      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send('session B: reply with the single word bravo');
      await chat.waitForAssistantTurn(0);
      await chat.waitForSessionCount(2);
    });

    // listSessions is ordered by updatedAt desc → B first, A second.
    const idsAfterCreate = await chat.listSessionIds();
    expect(idsAfterCreate).toHaveLength(2);
    const [activeSession, inactiveSession] = idsAfterCreate;
    expect(activeSession).not.toBe(inactiveSession);

    await test.step('delete the inactive session — active row stays put', async () => {
      await chat.deleteSession(inactiveSession);
      await chat.waitForSessionAbsent(inactiveSession);
      await chat.waitForSessionCount(1);
      // Active row identity unchanged.
      await chat.waitForActiveSession(activeSession);
      const remaining = await chat.listSessionIds();
      expect(remaining).toEqual([activeSession]);
    });

    await test.step('delete the active session — transcript clears + a fresh session appears', async () => {
      await chat.deleteSession(activeSession);
      await chat.waitForSessionAbsent(activeSession);
      // The auto-create effect in useAcp.ts (`currentSessionId == null`
      // branch) provisions a new session once the deletion settles, so
      // the picker should land back at exactly one row.
      await chat.waitForSessionCount(1);
      const replacements = await chat.listSessionIds();
      expect(replacements).toHaveLength(1);
      expect(replacements[0]).not.toBe(activeSession);

      // Old transcript was cleared by clearMessages(); the new session
      // is empty until the user sends.
      await expect(page.locator('[data-testid^="chat-message-turn-"]')).toHaveCount(0);
    });

    await test.step('the freshly-created session is usable', async () => {
      await chat.send('reply with the single word charlie');
      await chat.waitForAssistantTurn(0);
      const reply = (await chat.getAssistantText(0)).toLowerCase();
      expect(reply).toContain('charlie');
    });
  });
});
