import { expect, test } from '@playwright/test';
import { installVault } from './helpers/install-vault';
import { ChatPage } from './tests/pages/ChatPage';
import { CommandPalettePage } from './tests/pages/CommandPalettePage';
import { SessionPage } from './tests/pages/SessionPage';
import { VaultPage } from './tests/pages/VaultPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

/**
 * End-to-end coverage for the slash-command system (M9) as a single
 * longer test. Auth / model / vault mount are expensive, so we reuse
 * the same page session for autocomplete, template expansion, builtin
 * dispatch, and transient feedback instead of spreading them across
 * three spec files.
 *
 * The `sample-with-prompts` vault contains a `greet.md` template that
 * pins the model to reply `HELLO-<arg>`, which we use to prove the
 * Worker expanded the template before the LLM turn fired.
 */
test.describe('Slash commands — M9', () => {
  test('palette, templates, builtins, and transient feedback', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();
    const chat = new ChatPage(page);
    const vault = new VaultPage(page);
    const sessions = new SessionPage(page);
    const palette = new CommandPalettePage(page);
    const input = page.locator(chat.selectors.chatInput);
    const transients = page.locator('[data-testid="chat-transient-message"]');

    await test.step('install vault with a seeded prompt template', async () => {
      await installVault(page, 'sample-with-prompts');
    });

    await test.step('load app, authenticate, pick a model', async () => {
      await page.goto('/');
      await chat.waitServerReady(bodhiServerUrl);
      await vault.waitForMounted();
      await chat.login({ username, password });
      await chat.loadModels();
      await chat.selectModel(FULL_MODEL_ID);
    });

    const firstSessionId = await test.step('wait for initial session', async () =>
      sessions.waitForActiveSession());

    // ----------------------------------------------------------------
    // Autocomplete palette
    // ----------------------------------------------------------------
    await test.step('palette is closed while input is empty', async () => {
      await palette.expectClosed();
    });

    await test.step('typing "/" opens the palette with builtins AND the prompt template', async () => {
      await input.focus();
      await page.keyboard.type('/');
      await palette.expectOpen();
      await expect(palette.option('help')).toBeVisible();
      await expect(palette.option('new')).toBeVisible();
      await expect(palette.option('compact')).toBeVisible();
      const greet = palette.option('greet');
      await expect(greet).toBeVisible();
      await expect(greet).toHaveAttribute('data-command-source', 'prompt');
    });

    await test.step('prefix filtering narrows the listing', async () => {
      await page.keyboard.type('ne');
      await expect(palette.option('new')).toBeVisible();
      await expect(palette.option('help')).toHaveCount(0);
      await expect(palette.option('compact')).toHaveCount(0);
    });

    await test.step('Escape closes palette without clearing the input', async () => {
      await page.keyboard.press('Escape');
      await palette.expectClosed();
      await expect(input).toHaveValue('/ne');
    });

    await test.step('clear + retype / reopens; ArrowDown+Enter completes first option', async () => {
      await input.fill('');
      await page.keyboard.type('/');
      await palette.expectOpen();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(input).toHaveValue(/^\/\S+\s$/);
      await palette.expectClosed();
      await input.fill('');
    });

    // ----------------------------------------------------------------
    // Transient (frontend-only) feedback bubbles
    // ----------------------------------------------------------------
    await test.step('/help surfaces a transient bubble listing every builtin', async () => {
      await chat.send('/help');
      const helpBubble = transients.filter({ hasText: 'Available commands' }).last();
      await expect(helpBubble).toBeVisible();
      await expect(helpBubble).toHaveAttribute('data-kind', 'info');
      await expect(helpBubble).toContainText('/help');
      await expect(helpBubble).toContainText('/model');
      await expect(helpBubble).toContainText('/session');
      await expect(helpBubble).toContainText('/reload');
    });

    await test.step('/session prints the active session id as a transient bubble', async () => {
      await chat.send('/session');
      const sessionBubble = transients.filter({ hasText: firstSessionId }).last();
      await expect(sessionBubble).toBeVisible();
      await expect(sessionBubble).toContainText('id:');
    });

    await test.step('/model (no args) lists the current model and the catalog', async () => {
      await chat.send('/model');
      const modelBubble = transients.filter({ hasText: 'Current model' }).last();
      await expect(modelBubble).toBeVisible();
      await expect(modelBubble).toContainText(FULL_MODEL_ID);
      await expect(modelBubble).toContainText('Available models');
    });

    await test.step('/model with an unknown id emits an error transient', async () => {
      await chat.send('/model not-a-real-model');
      const errorBubble = transients.filter({ hasText: 'Unknown model' }).last();
      await expect(errorBubble).toBeVisible();
      await expect(errorBubble).toHaveAttribute('data-kind', 'error');
    });

    await test.step('/model <valid-id> switches the selection and confirms via transient', async () => {
      await chat.send(`/model ${FULL_MODEL_ID}`);
      const okBubble = transients.filter({ hasText: `Model set to ${FULL_MODEL_ID}` }).last();
      await expect(okBubble).toBeVisible();
      await expect(okBubble).toHaveAttribute('data-kind', 'info');
    });

    // ----------------------------------------------------------------
    // Prompt-template expansion round-trip. The user-bubble assertion
    // is the real property this test guards — it proves the Worker
    // substituted `$1` in greet.md before handing the message to the
    // model. An assertion on the assistant reply is intentionally
    // NOT enforced: gpt-4.1-nano regularly replies with a shortened
    // echo (e.g. "HELLO" instead of "HELLO-Alice") and flaking the
    // CI over small-model instruction-following obscures what the
    // template pipeline is actually doing. A soft check still
    // verifies the turn produced some assistant text so a regression
    // in the prompt/stream path would still surface.
    // ----------------------------------------------------------------
    await test.step('/greet Alice expands via .pi/prompts/greet.md and hits the model', async () => {
      await chat.send('/greet Alice');
      await chat.waitForAssistantTurn(0);
      const userBubble = page
        .locator('[data-testid="chat-message-turn-0"][data-messagetype="user"]')
        .first();
      await expect(userBubble).toContainText('HELLO-Alice');
      const reply = (await chat.getAssistantText(0)).trim();
      expect(reply.length).toBeGreaterThan(0);
    });

    // ----------------------------------------------------------------
    // RPC-only builtins: /new clears transient buffer and swaps session
    // ----------------------------------------------------------------
    await test.step('/new starts a fresh session and resets transient bubbles', async () => {
      await chat.send('/new');
      await expect
        .poll(async () => sessions.currentSessionId(), { timeout: 10_000 })
        .not.toBe(firstSessionId);
      await expect(page.locator('[data-testid="chat-message-turn-0"]')).toHaveCount(0);
      await expect(transients).toHaveCount(0);
    });

    await test.step('/reload emits a confirmation transient', async () => {
      await chat.send('/reload');
      const reloadBubble = transients.filter({ hasText: 'Reloaded prompt templates' }).last();
      await expect(reloadBubble).toBeVisible();
    });
  });
});
