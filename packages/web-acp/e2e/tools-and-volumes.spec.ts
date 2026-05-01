import { test, expect } from './tests/fixtures';
import { appReadyWithVolumes, appReloadReady } from './tests/flows';
import { FULL_MODEL_ID } from './tests/global-setup';

const GREET_TEMPLATE = [
  '---',
  'description: Greet someone by name',
  'argument-hint: <name>',
  '---',
  'Reply with exactly the following text and nothing else: BODHI-SLASH-OK $1',
].join('\n');

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

test.describe('tools and volumes', () => {
  test('multi-volume mount, vault commands & prompts, name collision, bash on/off, success + error', async ({
    page,
    setup,
    status,
    auth,
    chat,
    messages,
    volumes,
    features,
    picker,
  }) => {
    await test.step('setup — install two seeded volumes, boot, authenticate, pick OpenAI model', async () => {
      await appReadyWithVolumes(
        { page, setup, status, auth, chat, volumes },
        [
          {
            name: 'wiki',
            description: 'knowledge base',
            files: {
              '/marker.txt': 'BODHI-M2-SMOKE',
              '/.pi/commands/greet.md': GREET_TEMPLATE,
              '/.pi/prompts/poem.md': POEM_TEMPLATE,
              '/.pi/commands/dup.md': CMD_DUP,
              '/.pi/prompts/dup.md': PROMPT_DUP,
            },
          },
          {
            name: 'code',
            files: { '/readme.txt': 'code readme' },
          },
        ],
        { selectModel: FULL_MODEL_ID }
      );
      await volumes.expectMounted('wiki');
      await volumes.expectMounted('code');
    });

    await test.step('remove the "code" volume — count drops to 1', async () => {
      await volumes.remove('code');
      await volumes.waitForCount(1);
    });

    await test.step('reload — both seeded volumes return because the seed runs at boot', async () => {
      await page.reload();
      await appReloadReady({ page, setup, status });
      await volumes.waitForCount(2);
    });

    await test.step('vault slash command — /wiki:greet expands and drives the LLM', async () => {
      await chat.fillRaw('/');
      await picker.expectOpen();
      await picker.item('wiki:greet').waitFor();
      await picker.select('wiki:greet');
      await expect(chat.input).toHaveValue('/wiki:greet ');
      await chat.fillRaw('/wiki:greet alice');
      await chat.sendButton.click();
      const reply = messages.bubble(0, 'assistant');
      await expect.soft(reply).toContainText('BODHI-SLASH-OK');
      await expect.soft(reply).toContainText('alice');
    });

    await test.step('vault prompt template — /wiki:poem expands and drives the LLM', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.fillRaw('/');
      await picker.expectOpen();
      await picker.item('wiki:poem').waitFor();
      await picker.select('wiki:poem');
      await expect(chat.input).toHaveValue('/wiki:poem ');
      await chat.fillRaw('/wiki:poem cherry');
      await chat.sendButton.click();
      const reply = messages.bubble(0, 'assistant');
      await expect.soft(reply).toContainText('BODHI-PROMPT-OK');
      await expect.soft(reply).toContainText('cherry');
    });

    await test.step('collision — /wiki:dup expands to the command body, not the prompt body', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.fillRaw('/');
      await picker.expectOpen();
      await expect(picker.item('wiki:dup')).toHaveCount(1);
      await picker.select('wiki:dup');
      await expect(chat.input).toHaveValue('/wiki:dup ');
      await chat.sendButton.click();
      const reply = messages.bubble(0, 'assistant');
      await expect.soft(reply).toContainText('BODHI-CMD-WIN');
      await expect.soft(reply).not.toContainText('BODHI-PROMPT-LOSE');
    });

    await test.step('bashEnabled OFF — no tool-call rendered for the next turn', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await features.setState('bashEnabled', 'off');
      await chat.send('Reply with the single word "noop".');
      await chat.waitForAssistantTurn(0);
      await messages.expectNoToolCalls();
    });

    await test.step('bashEnabled ON + forceToolCall — agent reads /mnt/wiki/marker.txt', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await features.setState('bashEnabled', 'on');
      await features.setForceToolCallOn();
      await chat.send(
        'Use the bash tool. Run `cat /mnt/wiki/marker.txt` and respond with the file contents.'
      );
      await messages.toolCalls().first().waitFor({ timeout: 60_000 });
      await messages.waitForToolCallCompleted();
      await expect(messages.bubble(0, 'assistant')).toContainText('BODHI-M2-SMOKE');
    });

    await test.step('bash error — missing file surfaces non-zero exit code', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await features.setState('bashEnabled', 'on');
      await features.setForceToolCallOn();
      await chat.send(
        'Use the bash tool. Run `cat /mnt/wiki/missing.txt` and explain why the command failed.'
      );
      await messages.toolCalls().first().waitFor({ timeout: 60_000 });
      await messages.waitForToolCallCompleted();
      const exit = await messages.toolCallExitCode();
      expect.soft(exit).toMatch(/exit:\s*[1-9]/);
      await expect
        .soft(messages.bubble(0, 'assistant'))
        .toContainText(/missing|not found|no such/i);
    });
  });
});
