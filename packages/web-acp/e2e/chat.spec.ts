import { test, expect } from './tests/fixtures';
import { FULL_MODEL_ID, SECOND_FULL_MODEL_ID, getTestState } from './tests/global-setup';

test.describe('chat', () => {
  test('round-trip, model swap, stop streaming, logout/re-login', async ({
    page,
    setup,
    status,
    auth,
    chat,
    messages,
    sessions,
  }) => {
    await test.step('boot — pre-auth ModelCombobox is empty', async () => {
      const state = getTestState();
      await page.goto('/');
      await setup.walkIfPresent(state.bodhiServerUrl);
      await status.waitReady();
      await expect(chat.modelSelector).toHaveAttribute('data-test-state', 'empty');
    });

    await test.step('authenticate — combobox flips to loaded', async () => {
      const state = getTestState();
      await auth.login({ username: state.username, password: state.password });
      await status.expectAuthenticated();
      await chat.waitForModelsLoaded();
    });

    await test.step('pick OpenAI model', async () => {
      await chat.selectModel(FULL_MODEL_ID);
    });

    await test.step('simple round-trip — what day comes after monday', async () => {
      await chat.send('what day comes after monday? answer in one word');
      await expect(messages.bubble(0, 'assistant')).toContainText('tuesday', {
        ignoreCase: true,
      });
    });

    await test.step('swap to the Anthropic model in a fresh chat', async () => {
      await chat.newChat();
      await chat.selectModel(SECOND_FULL_MODEL_ID);
      await chat.send('what day comes after wednesday? answer in one word');
      await expect(messages.bubble(0, 'assistant')).toContainText('thursday', {
        ignoreCase: true,
      });
    });

    await test.step('stop streaming — long prompt, click btn-stop, chat goes idle, user bubble preserved', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send(
        'Write a 500-word essay about the history of the Roman Empire. Take your time.'
      );
      await chat.waitForStreaming();
      await chat.expectStopVisible();
      await chat.stop();
      await chat.waitForIdle();
      await chat.expectStopHidden();
      await expect(messages.bubble(0, 'user')).toBeVisible();
    });

    await test.step('logout — section flips, sessions empty, chat input disabled', async () => {
      await auth.logout();
      await status.expectUnauthenticated();
      await sessions.waitForCount(0);
      await chat.expectInputDisabled();
    });

    await test.step('re-login — sessions repopulate, chat is usable again', async () => {
      // Post-logout the Keycloak SSO cookie is still alive; the re-login
      // path skips the Keycloak password screen entirely.
      await auth.reloginAfterLogout();
      await status.expectAuthenticated();
      await expect(sessions.picker).not.toHaveAttribute('data-test-state', '0');
      await chat.waitForModelsLoaded();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send('reply with the single word ready');
      await expect(messages.bubble(0, 'assistant')).toContainText('ready', {
        ignoreCase: true,
      });
    });
  });
});
