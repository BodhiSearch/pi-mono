import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';
import { installRequestedMcps } from './helpers/install-requested-mcps';

test.describe('MCP tool roundtrip', () => {
  test.setTimeout(120_000);

  test('model calls everything__echo and the assistant surfaces the token verbatim', async ({
    page,
  }) => {
    const { username, password, bodhiServerUrl, mcpEverythingSlug, mcpEverythingUrl } =
      getTestState();

    // Each run mints a unique token so the echo assertion cannot pass
    // from a cached transcript. Kept short + uppercase so the model
    // doesn't try to interpret it as prose.
    const token = `WEB_ACP_M3_ECHO_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const expectedToolName = `${mcpEverythingSlug}__echo`;

    await installRequestedMcps(page, [mcpEverythingUrl]);

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password }, { acceptMcps: [mcpEverythingUrl] });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    // Wait for the MCP server to actually finish connecting before we
    // send — `tools/list` must have completed for the adapter to
    // register the MCP tool on the next `prompt` turn.
    await expect(page.locator(`[data-testid="mcp-server-${mcpEverythingSlug}"]`)).toHaveAttribute(
      'data-test-state',
      'connected',
      { timeout: 30_000 }
    );
    await expect(page.locator(`[data-testid="mcp-tool-${mcpEverythingSlug}-echo"]`)).toBeVisible({
      timeout: 15_000,
    });

    // DEV-only forceToolCall removes model flakiness: the first LLM
    // call will be required to pick a tool, and the only MCP tool
    // that trivially round-trips a string verbatim is `echo`.
    const forceToggle = page.locator('[data-testid="feature-toggle-forceToolCall"]');
    if (await forceToggle.isVisible()) {
      await forceToggle.click();
      await page
        .locator('[data-testid="feature-row-forceToolCall"][data-teststate="on"]')
        .waitFor();
    }

    await chat.send(
      `Call the ${expectedToolName} tool with {"message":"${token}"} and then reply with exactly the echoed text.`
    );

    const toolCall = page.locator(
      `[data-testid^="tool-call-"][data-toolname="${expectedToolName}"]`
    );
    await toolCall.first().waitFor({ timeout: 60_000 });
    const completed = page
      .locator(
        `[data-testid^="tool-call-"][data-toolname="${expectedToolName}"][data-teststate="completed"]`
      )
      .first();
    await completed.waitFor({ timeout: 60_000 });

    await chat.waitForAssistantTurn(0);
    const reply = await chat.getAssistantText(0);
    expect(reply).toContain(token);
  });
});
