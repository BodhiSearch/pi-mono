import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';
import { installVolumes } from './helpers/install-volumes';

const GREET_TEMPLATE = [
  '---',
  'description: Greet someone by name',
  'argument-hint: <name>',
  '---',
  'Reply with exactly the following text and nothing else: BODHI-SLASH-OK $1',
].join('\n');

test.describe('slash commands', () => {
  test.setTimeout(90_000);

  test('agent advertises a vault command, picker inserts it, expansion drives the LLM reply', async ({
    page,
  }) => {
    const { username, password, bodhiServerUrl } = getTestState();

    await installVolumes(page, [
      {
        name: 'wiki',
        description: 'knowledge base',
        files: {
          '/.pi/commands/greet.md': GREET_TEMPLATE,
        },
      },
    ]);

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    // Wait for the volume mount + the post-newSession refresh that
    // emits `available_commands_update`.
    await page.locator('[data-testid="volumes-panel"][data-test-state="1"]').waitFor();

    await test.step('typing `/` opens the picker with the seeded command', async () => {
      const input = page.locator('[data-testid="chat-input"]');
      await input.fill('/');
      await page
        .locator('[data-testid="command-picker"][data-test-state="open"]')
        .waitFor({ timeout: 10000 });
      await page.locator('[data-testid="command-picker-item-wiki:greet"]').waitFor();
    });

    await test.step('selecting the picker item inserts `/wiki:greet `', async () => {
      await page.locator('[data-testid="command-picker-item-wiki:greet"]').click();
      const input = page.locator('[data-testid="chat-input"]');
      await expect(input).toHaveValue('/wiki:greet ');
    });

    await test.step('appending an argument and sending drives the expanded prompt', async () => {
      const input = page.locator('[data-testid="chat-input"]');
      await input.fill('/wiki:greet alice');
      await page.locator('[data-testid="send-button"]').click();
      await chat.waitForAssistantTurn(0);
      const reply = await chat.getAssistantText(0);
      expect(reply).toContain('BODHI-SLASH-OK');
      expect(reply).toContain('alice');
    });
  });
});
