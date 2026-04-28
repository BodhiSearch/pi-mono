import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { getTestState } from './tests/global-setup';
import { installRequestedMcps } from './helpers/install-requested-mcps';

test.describe('MCP connect smoke', () => {
  test.setTimeout(90_000);

  test('worker connects to the everything MCP server and mirrors tools/list to the UI', async ({
    page,
  }) => {
    const { username, password, bodhiServerUrl, mcpEverythingSlug, mcpEverythingUrl } =
      getTestState();

    // Seed the requested-MCPs IDB list so Header.tsx →
    // loadRequestedMcps() picks the URL up before the user clicks
    // Login. This mirrors what `/mcp add <url>` does at runtime.
    await installRequestedMcps(page, [mcpEverythingUrl]);

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password }, { acceptMcps: [mcpEverythingUrl] });

    // MCP panel must expose a row for the enabled instance right after
    // login (before we even start a session).
    await page
      .locator(`[data-testid="mcp-server-${mcpEverythingSlug}"]`)
      .waitFor({ timeout: 15_000 });

    // A session is required for the worker to acquire MCP connections
    // — `session/new` is where the pool calls `createMcpClient`. The
    // demo shell opens the first session automatically once models are
    // loaded, so just load + select a model to trigger it.
    await chat.loadModels();

    await expect(page.locator(`[data-testid="mcp-server-${mcpEverythingSlug}"]`)).toHaveAttribute(
      'data-test-state',
      'connected',
      { timeout: 30_000 }
    );

    // The worker's tools/list snapshot is mirrored into the DOM via
    // McpPanel. We don't care about the full tool set — just that the
    // two canonical reference tools from the "everything" server reached
    // the main thread.
    await expect(page.locator(`[data-testid="mcp-tool-${mcpEverythingSlug}-echo"]`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(`[data-testid="mcp-tool-${mcpEverythingSlug}-get-sum"]`)).toBeVisible(
      { timeout: 15_000 }
    );
  });
});
