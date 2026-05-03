import { test, expect } from './tests/fixtures';
import { appReady, appReloadReady } from './tests/flows';
import { FULL_MODEL_ID, SECOND_FULL_MODEL_ID } from './tests/global-setup';

test.describe('sessions', () => {
  test('persistence, multi-model resume, delete inactive, delete active (auto-create)', async ({
    page,
    setup,
    status,
    auth,
    chat,
    messages,
    sessions,
  }) => {
    let sessionA = '';
    let sessionB = '';
    let titleA = '';

    await test.step('setup — boot, authenticate, pick OpenAI model', async () => {
      await appReady({ page, setup, status, auth, chat }, { selectModel: FULL_MODEL_ID });
    });

    await test.step('first turn — session A appears in the picker', async () => {
      await chat.send('what day comes after monday? answer in one word');
      await chat.waitForAssistantTurn(0);
      await sessions.waitForCount(1);
      [sessionA] = await sessions.listIds();
      expect(sessionA).toBeTruthy();
      titleA = await sessions.getTitle(sessionA);
      expect(titleA.toLowerCase()).toContain('monday');
    });

    await test.step('new chat with the Anthropic model — session B', async () => {
      await chat.newChat();
      await chat.selectModel(SECOND_FULL_MODEL_ID);
      await chat.send('what day comes after wednesday? answer in one word');
      await chat.waitForAssistantTurn(0);
      await sessions.waitForCount(2);
      const ids = await sessions.listIds();
      // listSessions is ordered by updatedAt desc → B first, A second.
      sessionB = ids[0] === sessionA ? ids[1] : ids[0];
      expect(sessionB).not.toBe(sessionA);
    });

    await test.step('switch to session A — model snaps to OpenAI, transcript shows tuesday', async () => {
      await sessions.click(sessionA);
      await expect(chat.modelSelector).toContainText(FULL_MODEL_ID);
      await expect(messages.bubble(0, 'assistant')).toContainText('tuesday', {
        ignoreCase: true,
      });
    });

    await test.step('switch to session B — model snaps to Anthropic, transcript shows thursday', async () => {
      await sessions.click(sessionB);
      await expect(chat.modelSelector).toContainText(SECOND_FULL_MODEL_ID);
      await expect(messages.bubble(0, 'assistant')).toContainText('thursday', {
        ignoreCase: true,
      });
    });

    await test.step('newChat — closeSession on B fires, B row stays in picker (close ≠ delete)', async () => {
      // closeSession only releases in-memory state; the persisted row must remain.
      await chat.newChat();
      await sessions.row(sessionB).waitFor();
      await sessions.row(sessionA).waitFor();
    });

    await test.step('reload — both sessions persist with stable titles + transcript', async () => {
      await page.reload();
      await appReloadReady({ page, setup, status });
      // Wait for both persisted rows to materialise, then immediately
      // click session B to pin currentSessionId. Pinning blocks the
      // auto-create useEffect (which fires on `currentSessionId == null`)
      // from provisioning an extra empty row in the background.
      await sessions.row(sessionA).waitFor();
      await sessions.row(sessionB).waitFor();
      await sessions.click(sessionB);
      await expect(chat.modelSelector).toContainText(SECOND_FULL_MODEL_ID);
      await expect(messages.bubble(0, 'assistant')).toContainText('thursday', {
        ignoreCase: true,
      });
      expect(await sessions.getTitle(sessionA)).toBe(titleA);
      await sessions.click(sessionA);
      await expect(chat.modelSelector).toContainText(FULL_MODEL_ID);
      await expect(messages.bubble(0, 'assistant')).toContainText('tuesday', {
        ignoreCase: true,
      });
      await sessions.click(sessionB);
      await sessions.expectActive(sessionB);
    });

    await test.step('follow-up turn on resumed session B works', async () => {
      await chat.send('reply with the single word friday');
      await expect(messages.bubble(1, 'assistant')).toContainText('friday', {
        ignoreCase: true,
      });
    });

    await test.step('delete inactive session A — A vanishes, B remains active', async () => {
      // After the follow-up, B is active; A is inactive.
      await sessions.expectActive(sessionB);
      await sessions.delete(sessionA);
      await sessions.waitAbsent(sessionA);
      await sessions.expectActive(sessionB);
      const ids = await sessions.listIds();
      expect(ids).toContain(sessionB);
      expect(ids).not.toContain(sessionA);
    });

    await test.step('delete active session B — auto-create kicks in, transcript clears', async () => {
      await sessions.delete(sessionB);
      await sessions.waitAbsent(sessionB);
      // The auto-create effect in useAcp provisions a fresh session
      // once the deletion settles. Picker must end up non-empty with
      // an empty transcript.
      await expect(sessions.picker).not.toHaveAttribute('data-test-state', '0');
      await expect(page.locator('[data-testid^="chat-message-turn-"]')).toHaveCount(0);
      const ids = await sessions.listIds();
      expect(ids).not.toContain(sessionB);
      expect(ids).not.toContain(sessionA);
    });

    await test.step('the freshly-auto-created session is usable', async () => {
      await chat.send('reply with the single word charlie');
      await expect(messages.bubble(0, 'assistant')).toContainText('charlie', {
        ignoreCase: true,
      });
    });
  });
});
