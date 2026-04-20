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

    await test.step('rename — picker trigger + row label reflect the new name', async () => {
      await sessions.rename('Renamed Chat');
      await expect(sessions.trigger).toContainText('Renamed Chat');
      await sessions.open();
      await expect(sessions.listItem(firstSessionId)).toContainText('Renamed Chat');
      await page.keyboard.press('Escape');
      await expect(sessions.list).not.toBeVisible();
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

    // ------------------------------------------------------------------
    // M6 — fork + in-session branch navigation
    // ------------------------------------------------------------------

    let forkParentEntryId: string | null = null;
    await test.step('M6: capture the assistant entry id to fork from', async () => {
      // The renamed first session has at least one user+assistant pair from
      // earlier in this spec. Wait until the entry ids are wired through
      // session_loaded events, then grab the assistant bubble's entry id.
      await expect
        .poll(async () => (await sessions.messageEntryIds()).length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(2);
      const assistantBubble = page
        .locator('[data-testid^="chat-message-turn-"][data-messagetype="assistant"]')
        .first();
      forkParentEntryId = await assistantBubble.getAttribute('data-entry-id');
      expect(forkParentEntryId).toBeTruthy();
    });

    let forkedSessionId: string | null = null;
    await test.step('M6: fork from the assistant message creates a new active session', async () => {
      if (!forkParentEntryId) throw new Error('forkParentEntryId not captured');
      await sessions.forkFromEntry(forkParentEntryId);
      // Worker swaps to the forked session and emits session_loaded; the
      // picker root data attribute updates to the new id.
      await expect
        .poll(async () => sessions.currentSessionId(), { timeout: 10_000 })
        .not.toBe(firstSessionId);
      forkedSessionId = await sessions.currentSessionId();
      expect(forkedSessionId).toBeTruthy();
      // Forked session inherits the parent's messages (linear copy).
      const firstBubble = page
        .locator('[data-testid="chat-message-turn-0"][data-messagetype="user"]')
        .first();
      await expect(firstBubble).toContainText('hello');
    });

    await test.step('M6: picker shows the fork indicator + parent breadcrumb', async () => {
      await sessions.open();
      if (!forkedSessionId) throw new Error('no forkedSessionId');
      const forkedRow = sessions.listItem(forkedSessionId);
      await expect(forkedRow).toBeVisible();
      await expect(forkedRow).toHaveAttribute('data-parent-session', firstSessionId);
      await expect(forkedRow.locator('[data-testid="session-fork-indicator"]')).toBeVisible();
      // Parent row stays at depth 0; forked row is at depth 1.
      await expect(forkedRow).toHaveAttribute('data-depth', '1');
      await page.keyboard.press('Escape');
      await expect(sessions.list).not.toBeVisible();
    });

    await test.step('M6: switch back to parent — original messages intact', async () => {
      await sessions.switchTo(firstSessionId);
      await expect
        .poll(async () => sessions.currentSessionId(), { timeout: 10_000 })
        .toBe(firstSessionId);
      const firstBubble = page
        .locator('[data-testid="chat-message-turn-0"][data-messagetype="user"]')
        .first();
      await expect(firstBubble).toContainText('hello');
    });

    await test.step('M6: branch from an earlier message — leaf moves, no new session', async () => {
      // Pick the user message entry id and "branch from here".
      const userBubble = page
        .locator('[data-testid="chat-message-turn-0"][data-messagetype="user"]')
        .first();
      const userEntryId = await userBubble.getAttribute('data-entry-id');
      expect(userEntryId).toBeTruthy();

      const beforeId = await sessions.currentSessionId();
      await sessions.branchFromEntry(userEntryId!);
      // navigateToLeaf is in-session — the active session id does NOT change.
      await expect.poll(async () => sessions.currentSessionId(), { timeout: 5_000 }).toBe(beforeId);
    });

    await test.step('M6: forked session is deletable; parent stays', async () => {
      if (!forkedSessionId) throw new Error('no forkedSessionId');
      await sessions.deleteSession(forkedSessionId);
      await page.keyboard.press('Escape');
      await sessions.open();
      await expect(sessions.listItem(forkedSessionId)).toHaveCount(0);
      // Parent (the renamed chat) is still in the list.
      await expect(sessions.listItem(firstSessionId)).toBeVisible();
      await page.keyboard.press('Escape');
    });
  });
});
