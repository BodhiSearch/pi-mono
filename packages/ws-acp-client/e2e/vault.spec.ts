import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { AuthPage } from './pages/AuthPage';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { getTestState } from './global-setup';
import { createPerSpecWsServer } from './utils/per-spec-ws';

// Phase 8 gate. No new code lands; this verifies that the vault
// command + prompt loader baked into `@bodhiapp/web-acp-agent` works
// over a `--volume` mount exposed by ws-acp-client (Phase 7).
//
// We pre-seed `<vault-dir>/.pi/{commands,prompts}/*.md` BEFORE the
// per-spec ws-acp-client boots so the agent's startup discovery picks
// them up, then drive three flows through the UI:
//
//   1. picker advertisement — `/` palette lists every entry under
//      `wiki:*` (greet, poem, dup),
//   2. expansion + LLM round-trip — `/wiki:greet alice` and
//      `/wiki:poem cherry` substitute `$1` and the assistant reply
//      contains the templated phrase,
//   3. command/prompt collision — `/wiki:dup` resolves to the command
//      body (priority over the prompt of the same name).
//
// 3 LLM calls. ~45-60s on a warm laptop.
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

test.describe('acp-ui ↔ ws-acp-client vault commands & prompts', () => {
  let vaultDir = '';
  let ws: ReturnType<typeof createPerSpecWsServer> | null = null;

  test.beforeAll(async () => {
    vaultDir = mkdtempSync(path.join(tmpdir(), 'ws-acp-vault-'));
    // Seed vault layout BEFORE spawning ws-acp-client so the agent's
    // command loader sees them on first session/new.
    const cmdDir = path.join(vaultDir, '.pi', 'commands');
    const promptDir = path.join(vaultDir, '.pi', 'prompts');
    mkdirSync(cmdDir, { recursive: true });
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(path.join(cmdDir, 'greet.md'), GREET_TEMPLATE, 'utf8');
    writeFileSync(path.join(promptDir, 'poem.md'), POEM_TEMPLATE, 'utf8');
    writeFileSync(path.join(cmdDir, 'dup.md'), CMD_DUP, 'utf8');
    writeFileSync(path.join(promptDir, 'dup.md'), PROMPT_DUP, 'utf8');

    ws = createPerSpecWsServer({
      volumes: [{ name: 'wiki', path: vaultDir }],
    });
    await ws.start();
  });

  test.afterAll(async () => {
    if (ws) {
      await ws.stop();
      ws = null;
    }
    if (vaultDir) {
      try {
        rmSync(vaultDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      vaultDir = '';
    }
  });

  test('picker advertises wiki:*, /wiki:greet + /wiki:poem expand, /wiki:dup wins as command', async ({ page }) => {
    if (!ws) throw new Error('per-spec ws-acp-client not initialised');
    const wsServer = ws;
    const state = getTestState();
    const auth = new AuthPage(page);
    const settings = new SettingsPage(page);
    const chat = new ChatPage(page);

    const AGENT_NAME = 'E2E-WS-VAULT';

    await test.step('Setup: login, configure Bodhi server, add vault-aware WS agent', async () => {
      await page.goto('/');
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();

      await settings.open();
      await settings.setBodhiServerUrl(state.bodhiServerUrl);
      await settings.close();

      await auth.login({ username: state.username, password: state.password });
      await auth.expectAuthenticated();

      await settings.open();
      await settings.addAgent({
        name: AGENT_NAME,
        transport: 'websocket',
        url: wsServer.url,
      });
      await settings.close();

      await chat.selectAgent(AGENT_NAME);
      await chat.setCwd(wsServer.cwd);
    });

    await test.step('New session — picker advertises wiki:greet, wiki:poem, wiki:dup', async () => {
      await chat.newSession();
      await chat.expectState('ready');
      await chat.selectModel(state.modelId);

      await chat.promptInput.fill('/');
      const palette = page.locator('.command-palette');
      await expect(palette).toBeVisible();
      // Each canonical name is `<mount>:<stem>` per
      // packages/web-acp-agent/src/agent/commands/path.ts.
      for (const name of ['wiki:greet', 'wiki:poem', 'wiki:dup']) {
        await expect.soft(palette.getByText(`/${name}`, { exact: true })).toBeVisible();
      }
      await chat.promptInput.fill('');
    });

    await test.step('/wiki:greet alice → templated reply contains "hello" + "alice"', async () => {
      await chat.send('/wiki:greet alice');
      await chat.expectState('idle');
      // After expansion the prompt is "Please respond with the phrase:
      // hello alice, how are you today". The model echoes that phrase
      // verbatim; assert on substrings rather than exact match so a
      // trailing punctuation drift doesn't break the gate. Vault
      // commands are NOT built-ins — no `data-test-builtin` attribute.
      await expect(chat.bubble(0, 'user')).not.toHaveAttribute('data-test-builtin', /.+/);
      const reply = chat.bubbleContent(1, 'assistant');
      await expect.soft(reply).toContainText(/hello/i);
      await expect.soft(reply).toContainText('alice');
    });

    await test.step('/wiki:poem cherry → templated reply contains "roses are red" + "cherry"', async () => {
      await chat.send('/wiki:poem cherry');
      await chat.expectState('idle');
      const reply = chat.bubbleContent(3, 'assistant');
      await expect.soft(reply).toContainText(/roses are red/i);
      await expect.soft(reply).toContainText('cherry');
    });

    await test.step('/wiki:dup → command body wins ("thousand miles"), prompt body absent', async () => {
      await chat.send('/wiki:dup');
      await chat.expectState('idle');
      const reply = chat.bubbleContent(5, 'assistant');
      await expect.soft(reply).toContainText(/thousand miles/i);
      await expect.soft(reply).not.toContainText(/actions speak/i);
    });
  });
});
