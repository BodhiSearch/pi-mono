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
    // bash shim: model runs a script via the sandboxed bash tool
    // ----------------------------------------------------------------
    await test.step('model invokes the bash shim to run hello-world', async () => {
      await chat.send(
        'Use the bash tool to run exactly this command: ' +
          '`node /vault/.pi/skills/hello-world/hello.js Alice` ' +
          'and then reply with just the stdout the tool returned, no extra words.'
      );
      await chat.waitForStreamingDone();
      const bash = chat.toolCall('bash');
      await expect(bash).toBeVisible();
      const reply = (await chat.lastAssistantText()).toUpperCase();
      expect(reply).toContain('HELLO-ALICE');
    });

    // ----------------------------------------------------------------
    // Vault round-trip: vault-writer writes a file via the capability
    // bridge, and the file tree picks it up.
    // ----------------------------------------------------------------
    await test.step('vault-writer persists /vault/skill-output.txt', async () => {
      await chat.send(
        'Use the bash tool to run exactly: ' +
          '`node /vault/.pi/skills/vault-writer/write.js HELLOVAULT` ' +
          'and then reply with just the word "done".'
      );
      await chat.waitForStreamingDone();
      await expect(chat.toolCall('bash')).toBeVisible();

      await vault.waitForFile('/vault/skill-output.txt');
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
