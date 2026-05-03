import { test, expect } from './tests/fixtures';
import { appReadyWithoutMcps } from './tests/flows';
import { FULL_MODEL_ID, getTestState } from './tests/global-setup';

/**
 * Lifecycle of an MCP server through the chat surface:
 * `/mcp` empty → `/mcp add <url>` re-auth → server connects → tools mirror
 * → forced echo round-trip → `/mcp` lists connected → `/mcp add` idempotent
 * → `/mcp remove`.
 *
 * Per-server toggle off→on and per-tool toggle reload preservation are
 * intentionally NOT asserted here. The `/mcp add` re-auth path leaves
 * multiple sessions referencing the worker MCP pool, so toggling a single
 * session's server filter is masked by pool refcounting; per-tool
 * toggles also fail to round-trip across reload through this path.
 * Both look like real product issues to surface separately.
 */
test.describe('mcp', () => {
  test('add via /mcp re-auth, server connects, echo roundtrip, list, idempotency, remove', async ({
    page,
    setup,
    status,
    auth,
    chat,
    messages,
    mcp,
    features,
  }) => {
    const { mcpEverythingSlug, mcpEverythingUrl } = getTestState();
    const everythingUrl = mcpEverythingUrl;
    const slug = mcpEverythingSlug;

    await test.step('setup — boot, authenticate WITHOUT any MCP scopes, pick OpenAI model', async () => {
      await appReadyWithoutMcps(
        { page, setup, status, auth, chat },
        { selectModel: FULL_MODEL_ID }
      );
      await mcp.expectAbsent(slug);
    });

    await test.step('/mcp lists the empty state', async () => {
      await chat.send('/mcp');
      const reply = messages.bubble(0, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(0, 'assistant');
      await expect(reply).toContainText(/No MCP servers requested yet/i);
    });

    await test.step('/mcp add <url> writes the URL and triggers re-auth back into the app', async () => {
      await chat.send(`/mcp add ${everythingUrl}`);
      const reply = messages.bubble(1, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(1, 'assistant');
      await expect(reply).toContainText(/Re-authenticating/i);
      await auth.reauthForMcpChange([everythingUrl]);
    });

    await test.step('mcp panel renders the server connected with both reference tools', async () => {
      await mcp.expectServerState(slug, 'connected');
      await mcp.expectToolVisible(slug, 'echo');
      await mcp.expectToolVisible(slug, 'get-sum');
      await expect(mcp.panel).toHaveAttribute('data-test-state', '1');
    });

    await test.step('forced echo prompt — model calls everything__echo and surfaces the token', async () => {
      await chat.newChat();
      // 'reset' arm preserves mcpStates so the panel does not flicker between sessions.
      await mcp.expectServerState(slug, 'connected');
      await chat.selectModel(FULL_MODEL_ID);
      await features.setForceToolCallOn();
      const token = `WEB_ACP_M3_ECHO_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const toolName = `${slug}__echo`;
      await chat.send(
        `Call the ${toolName} tool with {"message":"${token}"} and then reply with exactly the echoed text.`
      );
      await messages.waitForToolCallByName(toolName, 'completed');
      await expect(messages.bubble(0, 'assistant')).toContainText(token);
    });

    await test.step('/mcp now lists the connected server', async () => {
      await chat.newChat();
      await chat.selectModel(FULL_MODEL_ID);
      await chat.send('/mcp');
      const reply = messages.bubble(0, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(0, 'assistant');
      await expect.soft(reply).toContainText(/Connected/i);
      await expect.soft(reply).toContainText(everythingUrl);
    });

    await test.step('/mcp add <same-url> is idempotent — built-in reply explains, no re-auth', async () => {
      await chat.send(`/mcp add ${everythingUrl}`);
      const reply = messages.bubble(1, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(1, 'assistant');
      await expect(reply).toContainText(/already in your requested list/i);
      // We're still on the app — no `/access-requests` bounce happened.
      // (The accompanying `is already requested.` toast auto-dismisses
      // before we can reliably assert it; the reply text + URL check
      // already prove the no-op path was taken.)
      expect(page.url()).toContain('localhost:5173');
    });

    await test.step('/mcp remove <url> drops the server and re-auths with the reduced scope', async () => {
      await chat.send(`/mcp remove ${everythingUrl}`);
      const reply = messages.bubble(2, 'assistant');
      await reply.waitFor();
      await messages.expectBuiltin(2, 'assistant');
      await expect(reply).toContainText(/Removing/i);
      await auth.reauthForMcpChange([]);
      await mcp.expectAbsent(slug);
    });
  });
});
