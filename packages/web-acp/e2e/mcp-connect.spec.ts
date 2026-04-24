import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { getTestState } from './tests/global-setup';
import { installMcpEverythingUrl } from './helpers/install-mcp';

test.describe('MCP connect smoke', () => {
  test.setTimeout(90_000);

  test('worker connects to the everything MCP server and mirrors tools/list to the UI', async ({
    page,
  }) => {
    const { username, password, bodhiServerUrl, mcpEverythingSlug, mcpEverythingUrl } =
      getTestState();

    // Feed Header.tsx → resolveEverythingMcpUrl() through
    // window.__mcpEverythingUrl so the login flow requests access to
    // the same everything instance the global-setup seeded.
    await installMcpEverythingUrl(page, mcpEverythingUrl);

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password }, { acceptMcps: [mcpEverythingSlug] });

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
