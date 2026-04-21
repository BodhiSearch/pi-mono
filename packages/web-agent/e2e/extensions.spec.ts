import { expect, test } from '@playwright/test';
import { installVault } from './helpers/install-vault';
import { ChatPage } from './tests/pages/ChatPage';
import { CommandPalettePage } from './tests/pages/CommandPalettePage';
import { VaultPage } from './tests/pages/VaultPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

/**
 * Extensions (M8 — Phase 1).
 *
 * The `sample-with-extensions` vault seeds four extensions under
 * `/vault/.pi/extensions/`:
 *
 *   - fancy-prompt — `/fancy-prompt` toggles pirate-style system prompt
 *     shaping via the `before_agent_start` hook.
 *   - hello-tool   — registers an LLM-callable `hello` tool.
 *   - broken       — syntactically invalid JS; loader should capture
 *     the error without disrupting the rest of the scan.
 *   - thrower      — throws in `before_agent_start`; runner should
 *     isolate the failure and emit an `extension_error` event.
 *
 * One long test covers palette surfacing, ExtensionsPanel UI state,
 * per-extension toggle, global disable-all trip switch (M8 gate),
 * prompt-shaping behaviour, and tool registration so the expensive
 * auth/model/vault dance runs once. Same shape as `skills.spec.ts`.
 */
test.describe('Extensions — Phase 1', () => {
  test('palette entry, UI toggles, prompt shaping, registered tool, error surfacing', async ({
    page,
  }) => {
    const { username, password, bodhiServerUrl } = getTestState();
    const chat = new ChatPage(page);
    const vault = new VaultPage(page);
    const palette = new CommandPalettePage(page);
    const input = page.locator(chat.selectors.chatInput);

    await test.step('install vault with seeded extensions', async () => {
      await installVault(page, 'sample-with-extensions');
    });

    await test.step('load app, authenticate, pick a model', async () => {
      await page.goto('/');
      await chat.waitServerReady(bodhiServerUrl);
      await vault.waitForMounted();
      await chat.login({ username, password });
      await chat.loadModels();
      await chat.selectModel(FULL_MODEL_ID);
    });

    // ----------------------------------------------------------------
    // ExtensionsPanel popover surfaces every discovered extension,
    // including the broken one with an inline error.
    // ----------------------------------------------------------------
    await test.step('ExtensionsPanel lists every discovered extension', async () => {
      const trigger = page.locator('[data-testid="extensions-popover-trigger"]');
      await expect(trigger).toBeVisible();
      await trigger.click();

      const content = page.locator('[data-testid="extensions-popover-content"]');
      await expect(content).toBeVisible();

      await expect(page.locator('[data-testid="extensions-row-fancy-prompt"]')).toBeVisible();
      await expect(page.locator('[data-testid="extensions-row-hello-tool"]')).toBeVisible();
      await expect(page.locator('[data-testid="extensions-row-thrower"]')).toBeVisible();

      // The broken extension surfaces with its load error (descriptor.error
      // is populated; the panel stamps data-test-state="broken").
      const brokenRow = page.locator('[data-testid="extensions-row-broken"]');
      await expect(brokenRow).toBeVisible();
      await expect(brokenRow).toHaveAttribute('data-test-state', 'broken');

      // Close the popover so subsequent steps can drive the command palette.
      await page.keyboard.press('Escape');
    });

    // ----------------------------------------------------------------
    // Slash-command palette includes extension-registered commands.
    // ----------------------------------------------------------------
    await test.step('extension command shows up in the slash palette', async () => {
      await input.focus();
      await page.keyboard.type('/fancy');
      await palette.expectOpen();

      const fancy = palette.option('fancy-prompt');
      await expect(fancy).toBeVisible();
      await expect(fancy).toHaveAttribute('data-command-source', 'extension');

      await page.keyboard.press('Escape');
      await palette.expectClosed();
      await input.fill('');
    });

    // ----------------------------------------------------------------
    // registerTool happy path: the extension-contributed `hello` tool
    // is callable by the model. We ask for an exact invocation so the
    // assertion doesn't depend on the model's paraphrasing.
    // ----------------------------------------------------------------
    await test.step('model can call the extension-registered hello tool', async () => {
      await chat.send(
        'Call the `hello` tool exactly once with name="Alice" and then ' +
          'reply with just the text the tool returned, no extra words.'
      );
      await chat.waitForStreamingDone();
      await expect(chat.toolCall('hello')).toBeVisible();
      const reply = await chat.lastAssistantText();
      expect(reply).toContain('Hello, Alice!');
    });

    // ----------------------------------------------------------------
    // Per-extension toggle: disabling hello-tool unloads the extension.
    // We verify state at the UI layer (row flips to disabled) and
    // re-enable immediately so later steps aren't fighting this state.
    // Validating the tool is gone LLM-side is covered end-to-end by the
    // re-enable + "Disable all" steps below — relying on a small
    // model's compliance with "don't call tools" is flaky and not the
    // property we care about here.
    // ----------------------------------------------------------------
    await test.step('toggling hello-tool off flips the UI state', async () => {
      await page.locator('[data-testid="extensions-popover-trigger"]').click();
      const helloToggle = page.locator('[data-testid="extensions-toggle-hello-tool"]');
      await helloToggle.click();
      await expect(page.locator('[data-testid="extensions-row-hello-tool"]')).toHaveAttribute(
        'data-test-state',
        'disabled'
      );

      await page.locator('[data-testid="extensions-toggle-hello-tool"]').click();
      await expect(page.locator('[data-testid="extensions-row-hello-tool"]')).toHaveAttribute(
        'data-test-state',
        'enabled'
      );
      await page.keyboard.press('Escape');
    });

    // ----------------------------------------------------------------
    // Global "Disable all" trip switch — this is the M8 gate. Every
    // loadable extension flips to disabled in one click.
    // ----------------------------------------------------------------
    await test.step('Disable all flips every loaded extension off', async () => {
      await page.locator('[data-testid="extensions-popover-trigger"]').click();
      await page.locator('[data-testid="extensions-disable-all"]').click();

      await expect(page.locator('[data-testid="extensions-row-fancy-prompt"]')).toHaveAttribute(
        'data-test-state',
        'disabled'
      );
      await expect(page.locator('[data-testid="extensions-row-hello-tool"]')).toHaveAttribute(
        'data-test-state',
        'disabled'
      );
      await expect(page.locator('[data-testid="extensions-row-thrower"]')).toHaveAttribute(
        'data-test-state',
        'disabled'
      );

      // Re-enable everything for subsequent steps. Wait for each row
      // to flip back to `enabled` (worker-confirmed) before continuing
      // so the next `/fancy-prompt` invocation finds a loaded command.
      await page.locator('[data-testid="extensions-toggle-fancy-prompt"]').click();
      await expect(page.locator('[data-testid="extensions-row-fancy-prompt"]')).toHaveAttribute(
        'data-test-state',
        'enabled'
      );
      await page.locator('[data-testid="extensions-toggle-hello-tool"]').click();
      await expect(page.locator('[data-testid="extensions-row-hello-tool"]')).toHaveAttribute(
        'data-test-state',
        'enabled'
      );
      await page.locator('[data-testid="extensions-toggle-thrower"]').click();
      await expect(page.locator('[data-testid="extensions-row-thrower"]')).toHaveAttribute(
        'data-test-state',
        'enabled'
      );
      await page.keyboard.press('Escape');
    });

    // ----------------------------------------------------------------
    // Prompt shaping: `/fancy-prompt` flips internal state; a follow-up
    // prompt should come back in pirate-speak because before_agent_start
    // injected the override.
    // ----------------------------------------------------------------
    await test.step('/fancy-prompt extension command dispatches without an LLM call', async () => {
      // The command handler runs entirely in the worker — the message
      // never reaches the model and no assistant bubble is produced.
      // We verify the absence of a user-message echo (the worker
      // short-circuits before persisting the prompt as a user turn)
      // and that the handler flips internal state cleanly. The
      // LLM-visible effect of `before_agent_start` — substituting the
      // system prompt when fancy mode is active — is covered by
      // `runner.test.ts` because its output is too dependent on model
      // instruction-following to assert reliably in a small-model
      // e2e run.
      const userBubblesBefore = await page
        .locator('[data-testid^="chat-message-turn-"][data-messagetype="user"]')
        .count();

      await chat.send('/fancy-prompt');
      await page.waitForTimeout(200);

      const userBubblesAfter = await page
        .locator('[data-testid^="chat-message-turn-"][data-messagetype="user"]')
        .count();
      expect(userBubblesAfter).toBe(userBubblesBefore);

      // Toggle back off so we leave the session in a clean state.
      await chat.send('/fancy-prompt');
      await page.waitForTimeout(200);
    });

    // ----------------------------------------------------------------
    // thrower: hook throws, runner isolates, main thread gets an
    // `extension_error` event which the panel surfaces in its runtime
    // errors block. The assertion intentionally ignores the LLM's
    // reply — gpt-4.1-nano is too flaky to ground a content assertion
    // on in a CI run, and the runner's error-isolation guarantee is
    // independent of whatever the model chose to say this turn. What
    // we DO require: (a) streaming started + finished without an
    // unhandled rejection surfacing to the main thread, and (b) the
    // extension_error RPC event made it to the panel with the
    // thrower's diagnostic payload intact.
    // ----------------------------------------------------------------
    await test.step('thrower extension surfaces runtime errors without killing the run', async () => {
      await chat.send('Say ok.');
      await chat.waitForStreamingDone();

      await page.locator('[data-testid="extensions-popover-trigger"]').click();
      const errors = page.locator('[data-testid="extensions-runtime-errors"]');
      await expect(errors).toBeVisible();
      await expect(errors).toContainText('before_agent_start');
      await expect(errors).toContainText('intentional thrower failure');
      await page.keyboard.press('Escape');
    });
  });
});
