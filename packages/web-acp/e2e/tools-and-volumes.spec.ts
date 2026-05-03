import { test, expect } from './tests/fixtures';
import { appReadyWithVolumes, appReloadReady } from './tests/flows';
import { FULL_MODEL_ID } from './tests/global-setup';

const GREET_TEMPLATE = [
  '---',
  'description: Greet someone by name',
  'argument-hint: <name>',
  '---',
  'Please respond with the phrase: hello $1, how are you today',
].join('\n');

const POEM_TEMPLATE = [
  '---',
  'description: Write a short poem',
  'argument-hint: <topic>',
  '---',
  'Please respond with the phrase: roses are red, violets are blue, $1 is sweet too',
].join('\n');

const CMD_DUP = [
  '---',
  'description: command version takes priority',
  '---',
  'Please respond with the phrase: a journey of a thousand miles begins with a single step',
].join('\n');

const PROMPT_DUP = [
  '---',
  'description: prompt version is shadowed',
  '---',
  'Please respond with the phrase: actions speak louder than words',
].join('\n');

test.describe('tools and volumes', () => {
  test('multi-volume mount, vault commands & prompts, name collision, bash on/off, success + error', async ({
    page,
    setup,
    status,
    auth,
    chat,
    messages,
    sessions,
    volumes,
    features,
    picker,
  }) => {
    let bashSessionId = '';

    await test.step('setup — install two seeded volumes, boot, authenticate, pick OpenAI model', async () => {
      await appReadyWithVolumes(
        { page, setup, status, auth, chat, volumes },
        [
          {
            name: 'wiki',
            description: 'knowledge base',
            files: {
              '/marker.txt': 'be the change you want to see in the world',
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
      await expect.soft(reply).toContainText(/hello/i);
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
      await expect.soft(reply).toContainText(/roses are red/i);
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
      await expect.soft(reply).toContainText(/thousand miles/i);
      await expect.soft(reply).not.toContainText(/actions speak/i);
    });

    await test.step('bashEnabled OFF — no tool-call rendered for the next turn (anchor session id)', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await features.setState('bashEnabled', 'off');
      await expect(features.panel).toHaveAttribute('data-test-state', '0');
      await chat.send('Reply with the single word "noop".');
      await chat.waitForAssistantTurn(0);
      await messages.expectNoToolCalls();
      const ids = await sessions.listIds();
      bashSessionId = ids[0] ?? '';
      expect(bashSessionId).toBeTruthy();
    });

    await test.step('reload + re-pick session — bashEnabled toggle survives via LoadSessionResponse.configOptions', async () => {
      await page.reload();
      await appReloadReady({ page, setup, status });
      await sessions.row(bashSessionId).waitFor();
      await sessions.click(bashSessionId);
      await features.expectState('bashEnabled', 'off');
    });

    let forceToolSessionId = '';

    await test.step('forceToolCall ON — anchor session id', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await features.setForceToolCallOn();
      await chat.send('Reply with the single word "noop".');
      await chat.waitForAssistantTurn(0);
      const ids = await sessions.listIds();
      forceToolSessionId = ids[0] ?? '';
      expect(forceToolSessionId).toBeTruthy();
    });

    await test.step('reload + re-pick session — forceToolCall survives via LoadSessionResponse.configOptions', async () => {
      await page.reload();
      await appReloadReady({ page, setup, status });
      await sessions.row(forceToolSessionId).waitFor();
      await sessions.click(forceToolSessionId);
      await features.expectState('forceToolCall', 'on');
    });

    await test.step('bashEnabled ON + forceToolCall — agent reads /mnt/wiki/marker.txt', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await features.setState('bashEnabled', 'on');
      await features.setForceToolCallOn();
      await expect(features.panel).toHaveAttribute('data-test-state', '2');
      await chat.send(
        'Use the bash tool. Run `cat /mnt/wiki/marker.txt` and respond with the file contents.'
      );
      await messages.toolCalls().first().waitFor({ timeout: 60_000 });
      await messages.waitForToolCallCompleted();
      await expect(messages.bubble(0, 'assistant')).toContainText(/be the change/i);
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
