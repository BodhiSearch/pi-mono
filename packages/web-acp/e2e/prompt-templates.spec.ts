import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';
import { installVolumes } from './helpers/install-volumes';

/**
 * M4.2 — vault-sourced prompt templates.
 *
 * Templates live at `<mount>/.pi/prompts/**\/*.md`, register alongside
 * vault commands on the same `available_commands_update` wire, and
 * expand through the same `prompt()` path. The picker is a black-box
 * consumer — `AvailableCommand` carries no kind discriminator.
 *
 * Two scenarios:
 *   1. A prompt template is advertised, the picker inserts it, and
 *      argument expansion drives the LLM reply.
 *   2. When a command and a prompt share a canonical name, the
 *      command wins (M4.2 conflict rule).
 */

const POEM_TEMPLATE = [
  '---',
  'description: Write a short poem',
  'argument-hint: <topic>',
  '---',
  'Reply with exactly the following text and nothing else: BODHI-PROMPT-OK $1',
].join('\n');

const CMD_DUP = [
  '---',
  'description: command version (wins on conflict)',
  '---',
  'Reply with exactly the following text and nothing else: BODHI-CMD-WIN',
].join('\n');

const PROMPT_DUP = [
  '---',
  'description: prompt version (loses on conflict)',
  '---',
  'Reply with exactly the following text and nothing else: BODHI-PROMPT-LOSE',
].join('\n');

test.describe('prompt templates', () => {
  test.setTimeout(120_000);

  test('agent advertises a vault prompt template, picker inserts it, expansion drives the LLM reply', async ({
    page,
  }) => {
    const { username, password, bodhiServerUrl } = getTestState();

    await installVolumes(page, [
      {
        name: 'wiki',
        description: 'knowledge base',
        files: {
          '/.pi/prompts/poem.md': POEM_TEMPLATE,
        },
      },
    ]);

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    await page.locator('[data-testid="volumes-panel"][data-teststate="1"]').waitFor();

    await test.step('typing `/` opens the picker with the seeded prompt', async () => {
      const input = page.locator('[data-testid="chat-input"]');
      await input.fill('/');
      await page
        .locator('[data-testid="command-picker"][data-test-state="open"]')
        .waitFor({ timeout: 10000 });
      await page.locator('[data-testid="command-picker-item-wiki:poem"]').waitFor();
    });

    await test.step('selecting the picker item inserts `/wiki:poem `', async () => {
      await page.locator('[data-testid="command-picker-item-wiki:poem"]').click();
      const input = page.locator('[data-testid="chat-input"]');
      await expect(input).toHaveValue('/wiki:poem ');
    });

    await test.step('appending an argument and sending drives the expanded prompt', async () => {
      const input = page.locator('[data-testid="chat-input"]');
      await input.fill('/wiki:poem cherry');
      await page.locator('[data-testid="send-button"]').click();
      await chat.waitForAssistantTurn(0);
      const reply = await chat.getAssistantText(0);
      expect(reply).toContain('BODHI-PROMPT-OK');
      expect(reply).toContain('cherry');
    });
  });

  test('a command with the same canonical name wins; the prompt is dropped', async ({ page }) => {
    const { username, password, bodhiServerUrl } = getTestState();

    await installVolumes(page, [
      {
        name: 'wiki',
        description: 'knowledge base',
        files: {
          '/.pi/commands/dup.md': CMD_DUP,
          '/.pi/prompts/dup.md': PROMPT_DUP,
        },
      },
    ]);

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    await page.locator('[data-testid="volumes-panel"][data-teststate="1"]').waitFor();

    await test.step('only one `wiki:dup` entry appears in the picker', async () => {
      const input = page.locator('[data-testid="chat-input"]');
      await input.fill('/');
      await page
        .locator('[data-testid="command-picker"][data-test-state="open"]')
        .waitFor({ timeout: 10000 });
      const items = page.locator('[data-testid="command-picker-item-wiki:dup"]');
      await expect(items).toHaveCount(1);
    });

    await test.step('selecting the survivor closes the picker and inserts `/wiki:dup `', async () => {
      // Click the picker item (rather than typing the command) to mirror
      // `slash-commands.spec.ts` — clicking closes the picker and inserts
      // `<name> `, while typing the same text re-opens it and the send
      // button click would be captured by the picker.
      await page.locator('[data-testid="command-picker-item-wiki:dup"]').click();
      const input = page.locator('[data-testid="chat-input"]');
      await expect(input).toHaveValue('/wiki:dup ');
    });

    await test.step('the surviving entry expands to the command body, not the prompt body', async () => {
      await page.locator('[data-testid="send-button"]').click();
      await chat.waitForAssistantTurn(0);
      const reply = await chat.getAssistantText(0);
      expect(reply).toContain('BODHI-CMD-WIN');
      expect(reply).not.toContain('BODHI-PROMPT-LOSE');
    });
  });
});
