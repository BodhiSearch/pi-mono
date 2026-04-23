import { test, expect } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, SECOND_FULL_MODEL_ID, getTestState } from './tests/global-setup';

test.describe('ACP session resume', () => {
  test('reload + session switch restores model and transcript per session', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();

    // Session A — OpenAI
    await chat.selectModel(FULL_MODEL_ID);
    await chat.send('session A alpha: reply with the single word tuesday');
    await chat.waitForAssistantTurn(0);
    await chat.waitForSessionCount(1);
    const [sessionA] = await chat.listSessionIds();
    expect(sessionA).toBeTruthy();

    // Start a fresh chat to force a new session, then switch to Anthropic.
    await chat.newChat();
    await chat.selectModel(SECOND_FULL_MODEL_ID);
    await chat.send('session B beta: reply with the single word thursday');
    await chat.waitForAssistantTurn(0);
    await chat.waitForSessionCount(2);
    const idsBeforeReload = await chat.listSessionIds();
    expect(idsBeforeReload).toHaveLength(2);
    // listSessions is ordered by updatedAt desc → B first, A second.
    const [sessionBMaybe, sessionAMaybe] = idsBeforeReload;
    const sessionB = sessionBMaybe === sessionA ? sessionAMaybe : sessionBMaybe;
    expect(sessionB).not.toBe(sessionA);

    // Reload — IndexedDB rehydrates; Bodhi auth survives via stored tokens.
    await page.reload();
    await chat.waitServerReady(bodhiServerUrl);
    await page.locator('[data-testid="section-auth"][data-teststate="authenticated"]').waitFor();
    await chat.waitForSessionCount(2);
    const idsAfterReload = await chat.listSessionIds();
    expect(new Set(idsAfterReload)).toEqual(new Set([sessionA, sessionB]));

    // Load session A → model selector should snap to OpenAI and
    // transcript should contain the original assistant reply.
    await chat.clickSession(sessionA);
    await chat.waitForActiveSession(sessionA);
    await chat.waitForAssistantTurnOnRestoredSession();
    await expect(page.locator('[data-testid="model-selector"]')).toContainText(FULL_MODEL_ID);
    const replyA = (await chat.getAssistantText(0)).toLowerCase();
    expect(replyA).toContain('tuesday');

    // Switch to session B → model selector should snap to Anthropic and
    // transcript should contain the other assistant reply.
    await chat.clickSession(sessionB);
    await chat.waitForActiveSession(sessionB);
    await chat.waitForAssistantTurnOnRestoredSession();
    await expect(page.locator('[data-testid="model-selector"]')).toContainText(
      SECOND_FULL_MODEL_ID
    );
    const replyB = (await chat.getAssistantText(0)).toLowerCase();
    expect(replyB).toContain('thursday');

    // Follow-up prompt on the restored session should succeed — proves
    // InlineAgent.restoreMessages seeded the pi-agent-core history.
    await chat.send('reply with the single word friday');
    await chat.waitForAssistantTurn(1);
    const followUp = (await chat.getAssistantText(1)).toLowerCase();
    expect(followUp).toContain('friday');
  });
});
