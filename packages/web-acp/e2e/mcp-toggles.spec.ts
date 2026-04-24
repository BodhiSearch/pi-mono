import { expect, test } from '@playwright/test';
import { ChatPage } from './tests/pages/ChatPage';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';
import { installMcpEverythingUrl } from './helpers/install-mcp';

test.describe('MCP per-session toggles', () => {
  test.setTimeout(120_000);

  test('per-server toggle disconnects the pool; per-tool toggle persists across reload', async ({
    page,
  }) => {
    const { username, password, bodhiServerUrl, mcpEverythingSlug, mcpEverythingUrl } =
      getTestState();

    await installMcpEverythingUrl(page, mcpEverythingUrl);

    const chat = new ChatPage(page);
    await page.goto('/');
    await chat.waitServerReady(bodhiServerUrl);
    await chat.login({ username, password }, { acceptMcps: [mcpEverythingUrl] });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);

    // Wait for the worker to finish tools/list so the per-tool rows
    // actually render before we start flipping switches.
    await expect(page.locator(`[data-testid="mcp-server-${mcpEverythingSlug}"]`)).toHaveAttribute(
      'data-test-state',
      'connected',
      { timeout: 30_000 }
    );
    await page
      .locator(`[data-testid="mcp-tool-${mcpEverythingSlug}-echo"]`)
      .waitFor({ timeout: 15_000 });
    await page
      .locator(`[data-testid="mcp-tool-${mcpEverythingSlug}-get-sum"]`)
      .waitFor({ timeout: 15_000 });

    // Send a prompt so the current session is flushed into IndexedDB
    // (recordTurn) and shows up in the session picker. Without this
    // the reload-then-resume step below has no prior session row to
    // click.
    await chat.send('reply with the single word ready');
    await chat.waitForAssistantTurn(0);
    await chat.waitForSessionCount(1);
    const [sessionId] = await chat.listSessionIds();
    expect(sessionId).toBeTruthy();

    // --- Per-server toggle: turn `everything` off ------------------------
    const serverToggle = page.locator(`[data-testid="mcp-session-server-${mcpEverythingSlug}"]`);
    await expect(serverToggle).toHaveAttribute('data-test-state', 'on');
    await serverToggle.locator('input[type="checkbox"]').click();
    await expect(serverToggle).toHaveAttribute('data-test-state', 'off');
    // setMcpToggle(server, false) re-issues `session/load` with an
    // empty McpServerHttp[], so the pool releases its client and the
    // status row moves back to `disconnected`.
    await expect(page.locator(`[data-testid="mcp-server-${mcpEverythingSlug}"]`)).toHaveAttribute(
      'data-test-state',
      'disconnected',
      { timeout: 15_000 }
    );

    // --- Per-server toggle: turn it back on, expect reconnect ------------
    await serverToggle.locator('input[type="checkbox"]').click();
    await expect(serverToggle).toHaveAttribute('data-test-state', 'on');
    await expect(page.locator(`[data-testid="mcp-server-${mcpEverythingSlug}"]`)).toHaveAttribute(
      'data-test-state',
      'connected',
      { timeout: 30_000 }
    );

    // --- Per-tool toggle: flip get-sum off, echo stays on ----------------
    const getSumToggle = page.locator(
      `[data-testid="mcp-session-tool-${mcpEverythingSlug}-get-sum"]`
    );
    await getSumToggle.waitFor({ timeout: 15_000 });
    await expect(getSumToggle).toHaveAttribute('data-test-state', 'on');
    await getSumToggle.locator('input[type="checkbox"]').click();
    await expect(getSumToggle).toHaveAttribute('data-test-state', 'off');

    const echoToggle = page.locator(`[data-testid="mcp-session-tool-${mcpEverythingSlug}-echo"]`);
    await expect(echoToggle).toHaveAttribute('data-test-state', 'on');

    // --- Reload → click the persisted session, toggles must restore -----
    await page.reload();
    await chat.waitServerReady(bodhiServerUrl);
    await page.locator('[data-testid="section-auth"][data-teststate="authenticated"]').waitFor();
    await chat.waitForSessionCount(1);
    await chat.clickSession(sessionId);
    await chat.waitForActiveSession(sessionId);

    // Server was re-enabled before reload, so the row should reconnect
    // again once `session/load` reacquires the pool entry.
    await expect(page.locator(`[data-testid="mcp-server-${mcpEverythingSlug}"]`)).toHaveAttribute(
      'data-test-state',
      'connected',
      { timeout: 30_000 }
    );
    await expect(
      page.locator(`[data-testid="mcp-session-server-${mcpEverythingSlug}"]`)
    ).toHaveAttribute('data-test-state', 'on');
    await expect(
      page.locator(`[data-testid="mcp-session-tool-${mcpEverythingSlug}-get-sum"]`)
    ).toHaveAttribute('data-test-state', 'off', { timeout: 15_000 });
    await expect(
      page.locator(`[data-testid="mcp-session-tool-${mcpEverythingSlug}-echo"]`)
    ).toHaveAttribute('data-test-state', 'on');
  });
});
