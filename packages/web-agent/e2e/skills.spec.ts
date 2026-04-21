import { expect, test } from '@playwright/test';
import { installVault } from './helpers/install-vault';
import { ChatPage } from './tests/pages/ChatPage';
import { CommandPalettePage } from './tests/pages/CommandPalettePage';
import { VaultPage } from './tests/pages/VaultPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

/**
 * Skills — palette entry, /skill:<name> expansion, sandboxed bash
 * shim execution, vault round-trip, and /reload rescan.
 *
 * The `sample-with-skills` fixture seeds three tiny skills under
 * `/vault/.pi/skills/`:
 *
 *   - hello-world  (node hello.js <name> -> prints HELLO-<name>)
 *   - fetch-demo   (node fetch.js <url>  -> prints STATUS/BODY)
 *   - vault-writer (node write.js <text> -> writes /vault/skill-output.txt)
 *
 * One long test keeps the expensive auth/model/vault setup cost to a
 * single run — mirrors the structure of `slash-commands.spec.ts`.
 */
test.describe('Skills — sandboxed bash shim', () => {
  test('palette entry, /skill expansion, bash-tool round-trip, reload', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();
    const chat = new ChatPage(page);
    const vault = new VaultPage(page);
    const palette = new CommandPalettePage(page);
    const input = page.locator(chat.selectors.chatInput);
    const transients = page.locator('[data-testid="chat-transient-message"]');

    await test.step('install vault with seeded skills', async () => {
      await installVault(page, 'sample-with-skills');
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
    // Palette: all three skills show up with source="skill"
    // ----------------------------------------------------------------
    await test.step('typing "/skill:" surfaces every seeded skill', async () => {
      await input.focus();
      await page.keyboard.type('/skill:');
      await palette.expectOpen();

      const helloOpt = palette.option('skill:hello-world');
      await expect(helloOpt).toBeVisible();
      await expect(helloOpt).toHaveAttribute('data-command-source', 'skill');

      await expect(palette.option('skill:fetch-demo')).toBeVisible();
      await expect(palette.option('skill:vault-writer')).toBeVisible();

      await page.keyboard.press('Escape');
      await palette.expectClosed();
      await input.fill('');
    });

    // ----------------------------------------------------------------
    // /skill:<name> expansion — user bubble should carry the XML block
    // ----------------------------------------------------------------
    await test.step('/skill:hello-world Alice expands to <skill> wrapper', async () => {
      await chat.send('/skill:hello-world Alice');
      await chat.waitForAssistantTurn(0);
      const userBubble = page
        .locator('[data-testid="chat-message-turn-0"][data-messagetype="user"]')
        .first();
      await expect(userBubble).toContainText('<skill name="hello-world"');
      await expect(userBubble).toContainText('Alice');
    });

    // ----------------------------------------------------------------
    // bash shim: model runs a script via the sandboxed bash tool. We
    // assert on the bash tool's own arguments + captured stdout rather
    // than the assistant's echoed reply — gpt-4.1-nano frequently
    // produces an empty string after a tool call, and the sandbox
    // round-trip is the property this test actually guards.
    // ----------------------------------------------------------------
    await test.step('model invokes the bash shim to run hello-world', async () => {
      // The preceding `/skill:hello-world Alice` step already asked the
      // model to run the skill, so a first `bash` tool-call may already
      // be on the page. We scope assertions to the *latest* bash widget
      // (`.last()`) to avoid strict-mode violations and keep this step
      // independent of whether the previous turn ran a tool.
      await chat.send(
        'Use the bash tool to run exactly this command: ' +
          '`node /vault/.pi/skills/hello-world/hello.js Alice` ' +
          'and then reply with just the stdout the tool returned, no extra words.'
      );
      await chat.waitForStreamingDone();
      const bash = chat.toolCall('bash').last();
      await expect(bash).toBeVisible();

      // Expand the tool-call widget so its arguments + captured stdout
      // render, then assert against them directly. This bypasses the
      // model-instruction-following step entirely.
      await bash.locator('[data-testid="tool-call-expand"]').click();
      const content = bash.locator('[data-testid="tool-call-content"]');
      await expect(content).toBeVisible();
      await expect(content).toContainText('hello-world/hello.js');
      await expect(content).toContainText('Alice');
      await expect(content).toContainText(/HELLO-ALICE/i);
    });

    // ----------------------------------------------------------------
    // Vault round-trip: vault-writer writes a file via the capability
    // bridge, and the file tree picks it up. The prompt is phrased
    // imperatively so gpt-4.1-nano actually calls the tool instead of
    // answering from the hello-world turn's context. We loop once if
    // the vault file does not materialise after the first stream —
    // the file existing is a sufficient witness that bash ran with
    // the right arguments, so no intermediate tool-call assertion is
    // needed.
    // ----------------------------------------------------------------
    await test.step('vault-writer persists /vault/skill-output.txt', async () => {
      const writerPrompt =
        'You MUST call the bash tool right now. ' +
        'Run this command verbatim and return only its stdout: ' +
        '`node /vault/.pi/skills/vault-writer/write.js HELLOVAULT`';
      await chat.send(writerPrompt);
      await chat.waitForStreamingDone();

      let created = false;
      try {
        await vault.waitForFile('/vault/skill-output.txt', 8_000);
        created = true;
      } catch {
        // Small-model flake: prompt once more before declaring failure.
        await chat.send(writerPrompt);
        await chat.waitForStreamingDone();
        await vault.waitForFile('/vault/skill-output.txt', 15_000);
        created = true;
      }
      expect(created).toBe(true);

      await vault.openFile('/vault/skill-output.txt');
      expect((await vault.currentFileContent()).trim()).toBe('HELLOVAULT');
    });

    // ----------------------------------------------------------------
    // /reload rescans the vault and reports the skill count
    // ----------------------------------------------------------------
    await test.step('/reload transient surfaces the skill count', async () => {
      await chat.send('/reload');
      const reloadBubble = transients.filter({ hasText: 'Reloaded prompt templates' }).last();
      await expect(reloadBubble).toBeVisible();
      await expect(reloadBubble).toContainText('3 skill');
    });
  });
});
