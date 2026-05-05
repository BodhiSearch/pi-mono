import { expect } from '@playwright/test';
import { test } from './tests/fixtures';
import { appReadyWithVolumes, appReloadReady } from './tests/flows';
import { FULL_MODEL_ID } from './tests/global-setup';
import { readExampleExtension } from './helpers/install-extensions';
import { mockNpmPackage } from './helpers/mock-npm-registry';

test.describe('extensions', () => {
  test('vault-sourced extensions: discovery, lifecycle, slash commands, providers, toggles', async ({
    context,
    page,
    setup,
    status,
    auth,
    chat,
    messages,
    volumes,
    extensions,
    features,
    sessions,
  }) => {
    await test.step('phase 2 — boot with seeded hello extension; _bodhi/extensions/list reports it', async () => {
      const helloPassiveFiles = await readExampleExtension('hello-passive');
      const helloToolFiles = await readExampleExtension('hello-tool');
      const pirateFiles = await readExampleExtension('pirate');
      const claudeRulesFiles = await readExampleExtension('claude-rules');
      const inputTransformFiles = await readExampleExtension('input-transform');
      const protectedPathsFiles = await readExampleExtension('protected-paths');
      const redactSecretsFiles = await readExampleExtension('redact-secrets');
      const commandsFiles = await readExampleExtension('commands');
      const sessionCounterFiles = await readExampleExtension('session-counter');
      const providerPayloadFiles = await readExampleExtension('provider-payload');
      const rateLimitWatchFiles = await readExampleExtension('rate-limit-watch');
      const eventBusPingFiles = await readExampleExtension('event-bus-ping');
      const eventBusPongFiles = await readExampleExtension('event-bus-pong');
      const customProviderAnthropicFiles = await readExampleExtension('custom-provider-anthropic');
      await appReadyWithVolumes(
        { page, setup, status, auth, chat, volumes },
        [
          {
            name: 'wiki',
            description: 'extension host volume',
            tags: ['data', 'agent-wd'],
            files: {
              ...helloPassiveFiles,
              ...helloToolFiles,
              ...pirateFiles,
              ...claudeRulesFiles,
              ...inputTransformFiles,
              ...protectedPathsFiles,
              ...redactSecretsFiles,
              ...commandsFiles,
              ...sessionCounterFiles,
              ...providerPayloadFiles,
              ...rateLimitWatchFiles,
              ...eventBusPingFiles,
              ...eventBusPongFiles,
              ...customProviderAnthropicFiles,
              '/.claude/rules/testing.md': '# Testing rules\n- prefer vitest',
              '/.claude/rules/style.md': '# Style rules\n- 2-space indents',
            },
          },
        ],
        { selectModel: FULL_MODEL_ID }
      );
      await volumes.expectMounted('wiki');
      await extensions.waitForCount(14);
      await extensions.expectMount('hello-passive', 'wiki');
      await extensions.expectMount('hello-tool', 'wiki');
      await extensions.expectMount('pirate', 'wiki');
      await extensions.expectMount('claude-rules', 'wiki');
      await extensions.expectMount('input-transform', 'wiki');
      await extensions.expectMount('protected-paths', 'wiki');
      await extensions.expectMount('redact-secrets', 'wiki');
      await extensions.expectMount('commands', 'wiki');
      await extensions.expectMount('session-counter', 'wiki');
      await extensions.expectMount('provider-payload', 'wiki');
      await extensions.expectMount('rate-limit-watch', 'wiki');
      await extensions.expectMount('event-bus-ping', 'wiki');
      await extensions.expectMount('event-bus-pong', 'wiki');
      await extensions.expectMount('custom-provider-anthropic', 'wiki');
      await extensions.expectEvents('hello-passive', ['session_start']);
      await extensions.expectEvents('pirate', ['before_agent_start']);
      await extensions.expectEvents('claude-rules', ['session_start', 'before_agent_start']);
      await extensions.expectEvents('input-transform', ['input']);
      await extensions.expectEvents('protected-paths', ['tool_call']);
      await extensions.expectEvents('redact-secrets', ['tool_result']);
      await extensions.expectEvents('session-counter', ['session_start', 'before_agent_start']);
      await extensions.expectEvents('provider-payload', [
        'before_provider_request',
        'after_provider_response',
      ]);
      await extensions.expectEvents('rate-limit-watch', ['after_provider_response']);
    });

    await test.step('phase 3 — pirate before_agent_start patches systemPrompt; assistant adopts persona', async () => {
      await chat.send(
        'Greet me in one short sentence. Use a pirate exclamation word like "Arrr" or "Ahoy" to make it obvious.'
      );
      await chat.waitForAssistantTurn(0);
      await expect(messages.bubble(0, 'assistant')).toContainText(/arrr|ahoy|matey|avast/i);
    });

    await test.step('phase 3 — claude-rules surfaces .claude/rules paths in systemPrompt', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send(
        'List every project rule path you were told about in your system prompt. Reply with one path per line, exact text only, no commentary.'
      );
      await chat.waitForAssistantTurn(0);
      const reply = messages.bubble(0, 'assistant');
      await expect.soft(reply).toContainText('/mnt/wiki/.claude/rules/testing.md');
      await expect.soft(reply).toContainText('/mnt/wiki/.claude/rules/style.md');
    });

    await test.step('phase 4 — input-transform rewrites ?quick prompts before LLM sees them', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send('?quick what is two plus two');
      await chat.waitForAssistantTurn(0);
      await expect(messages.bubble(0, 'assistant')).toContainText(/QUICK:/);
    });

    await test.step('phase 5 — hello-tool: extension-registered tool is callable by the LLM', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await features.setForceToolCallOn();
      await chat.send(
        'Greet the user named Phoebe by calling the hello tool. Then in your reply repeat the tool output verbatim.'
      );
      await messages.waitForToolCallByName('hello');
      await expect(messages.toolCallByName('hello').first()).toHaveAttribute(
        'data-test-state',
        'completed'
      );
      await expect(messages.bubble(0, 'assistant')).toContainText(/from hello-tool extension/);
    });

    await test.step('phase 6 — protected-paths blocks bash writes that touch .env', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send(
        "Use the bash tool to run exactly: `echo 'SECRET=zzz' > /mnt/wiki/.env`. Try once. If the tool reports an error, stop and tell me the exact reason."
      );
      await chat.waitForAssistantTurn(0);
      const reply = messages.bubble(0, 'assistant');
      await expect(reply).toContainText(/protected-paths/);
    });

    await test.step('phase 6 — redact-secrets scrubs API key shapes from tool output', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send(
        'Use the bash tool to run exactly: `printf "token=sk-ABCDEFGHIJKL\\n"`. Then in your reply repeat the tool output verbatim.'
      );
      await chat.waitForAssistantTurn(0);
      const reply = messages.bubble(0, 'assistant');
      await expect(reply).toContainText(/\[REDACTED\]/);
      await expect(reply).not.toContainText(/sk-ABCDEFGHIJKL/);
    });

    await test.step('phase 7 — /volumes runs entirely on the agent (muted reply, no LLM)', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send('/volumes');
      await chat.waitForAssistantTurn(0);
      const reply = messages.bubble(0, 'assistant');
      await expect(reply).toContainText(/\/mnt\/wiki/);
      await messages.expectBuiltin(0, 'assistant');
      await messages.expectBuiltinBadge(0);
    });

    await test.step('phase 11 — pi.registerProvider surfaces extension models in the picker', async () => {
      await chat.newChat();
      const trigger = page.locator('[data-testid="model-selector"]');
      await expect(trigger).toBeEnabled();
      await trigger.click();
      await page.locator('[data-testid="model-search-input"]').fill('claude-opus-4-5');
      await expect(page.getByTestId('model-option-claude-opus-4-5')).toBeVisible();
      await page.locator('[data-testid="model-search-input"]').fill('claude-sonnet-4-5');
      await expect(page.getByTestId('model-option-claude-sonnet-4-5')).toBeVisible();
      await page.keyboard.press('Escape');
    });

    await test.step('phase 12 — /extension off disables a loaded extension and confirms via /extension list', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send('/extension off pirate');
      await chat.waitForAssistantTurn(0);
      await expect(messages.bubble(0, 'assistant')).toContainText(/`pirate` is now disabled/);
      await messages.expectBuiltin(0, 'assistant');
      await chat.send('/extension list');
      await chat.waitForAssistantTurn(1);
      await expect(messages.bubble(1, 'assistant')).toContainText(/Disabled:[\s\S]*`pirate`/);
      await extensions.waitForCount(13);
    });

    await test.step('phase 12 — disabled toggle survives a hard reload via extensions:disabled', async () => {
      await page.reload();
      await appReloadReady({ page, setup, status });
      await extensions.waitForCount(13);
    });

    await test.step('phase 12 — /extension on re-enables and the registry restores the toggle', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send('/extension on pirate');
      await chat.waitForAssistantTurn(0);
      await expect(messages.bubble(0, 'assistant')).toContainText(/`pirate` is now enabled/);
      await extensions.waitForCount(14);
      await extensions.expectMount('pirate', 'wiki');
    });

    let pingPongSessionId = '';
    await test.step('phase 10 — pi.events delivers ping → pong → ping across two extensions', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send('/ping 7');
      await chat.waitForAssistantTurn(0);
      const ids = await sessions.listIds();
      pingPongSessionId = ids[0] ?? '';
      expect(pingPongSessionId).toBeTruthy();
    });

    await test.step('phase 10 — ping/pong entries survive reload as muted bubbles', async () => {
      await page.reload();
      await appReloadReady({ page, setup, status });
      await sessions.row(pingPongSessionId).waitFor();
      await sessions.click(pingPongSessionId);
      const pongSide = page.locator('[data-builtin-command="extension:event-bus-pong:event-bus"]');
      const pingSide = page.locator('[data-builtin-command="extension:event-bus-ping:event-bus"]');
      await expect(pongSide.first()).toBeVisible();
      await expect(pingSide.first()).toBeVisible();
      await expect(pongSide.first()).toContainText('"role":"pong"');
      await expect(pongSide.first()).toContainText('"received":"ping"');
      await expect(pongSide.first()).toContainText('"seq":7');
      await expect(pingSide.first()).toContainText('"role":"ping"');
      await expect(pingSide.first()).toContainText('"received":"pong"');
      await expect(pingSide.first()).toContainText('"seq":7');
    });

    let counterSessionId = '';
    await test.step('phase 8 — session-counter increments across turns; entries persist via session store', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send('Reply with the single word "ack" and nothing else.');
      await chat.waitForAssistantTurn(0);
      await chat.send('Reply with the single word "ack2" and nothing else.');
      await chat.waitForAssistantTurn(1);
      const ids = await sessions.listIds();
      counterSessionId = ids[0] ?? '';
      expect(counterSessionId).toBeTruthy();
    });

    await test.step('phase 8 + 9 — counter, provider-payload, and rate-limit entries survive reload via reconstructMessages', async () => {
      await page.reload();
      await appReloadReady({ page, setup, status });
      await sessions.row(counterSessionId).waitFor();
      await sessions.click(counterSessionId);
      const counterBubbles = page.locator(
        '[data-builtin-command="extension:session-counter:counter"]'
      );
      // session_start writes turns:0; before_agent_start writes turns:1
      // and turns:2 across the two prompts in the prior step.
      await expect(counterBubbles).toHaveCount(3);
      await expect(counterBubbles.nth(0)).toContainText('"turns":0');
      await expect(counterBubbles.nth(1)).toContainText('"turns":1');
      await expect(counterBubbles.nth(2)).toContainText('"turns":2');

      // Phase 9: the same two LLM round-trips fire the provider
      // hooks twice — `before_provider_request` writes a payload
      // observation, `after_provider_response` writes a status
      // observation, and `rate-limit-watch` adds its own
      // status-tagged entry from `after_provider_response`.
      const providerBubbles = page.locator(
        '[data-builtin-command="extension:provider-payload:provider-payload"]'
      );
      await expect(providerBubbles.first()).toBeVisible();
      await expect(
        providerBubbles.filter({ hasText: '"hook":"before_provider_request"' }).first()
      ).toBeVisible();
      await expect(
        providerBubbles.filter({ hasText: '"hook":"after_provider_response"' }).first()
      ).toBeVisible();

      const rateLimitBubbles = page.locator(
        '[data-builtin-command="extension:rate-limit-watch:rate-limit"]'
      );
      await expect(rateLimitBubbles.first()).toBeVisible();
      await expect(rateLimitBubbles.first()).toContainText('"status":');
    });

    await test.step('phase 13 — /extension add fetches a tarball, unpacks under agent-wd, and the new command runs', async () => {
      const mock = await mockNpmPackage(context, {
        name: 'pi-greet-fixture',
        exampleDir: 'pi-greet-fixture',
      });
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send(
        `/extension add pi-greet-fixture --registry ${new URL(mock.metadataUrl).origin}`
      );
      await chat.waitForAssistantTurn(0);
      const installReply = messages.bubble(0, 'assistant');
      await expect(installReply).toContainText(/Installed `pi-greet-fixture@1\.0\.0`/);
      await expect(installReply).toContainText('/mnt/wiki/.pi/extensions/pi-greet-fixture@1.0.0');
      await messages.expectBuiltin(0, 'assistant');

      await extensions.waitForCount(15);
      await extensions.expectMount('pi-greet-fixture@1.0.0', 'wiki');

      await chat.send('/pi-greet Phoebe');
      await chat.waitForAssistantTurn(1);
      await expect(messages.bubble(1, 'assistant')).toContainText(
        /pi-greet-fixture says: hello Phoebe!/
      );
      await messages.expectBuiltin(1, 'assistant');
    });
  });
});
