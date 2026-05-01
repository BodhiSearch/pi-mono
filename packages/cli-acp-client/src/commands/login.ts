import type { SlashCommand } from '../shell/registry';
import type { AppContext } from '../shell/context';
import { setStatus } from '../shell/context';
import { runLoginFlow } from '../auth/login-flow';
import { formatErrorChain } from '../auth/debug';

/**
 * `/login` orchestrates the BodhiApp access-request + Keycloak PKCE flow,
 * persists the resulting tokens, and pushes them to the embedded agent
 * via ACP `authenticate`. Reads `requestedMcps` from settings so the
 * approved scope covers the user's stored MCP wishlist.
 */
export const loginCommand: SlashCommand = {
  name: 'login',
  description: 'Trigger the BodhiApp access-request + OAuth login flow.',
  async handler(ctx) {
    await runLogin(ctx);
  },
};

export async function runLogin(ctx: AppContext): Promise<void> {
  const settings = await ctx.settings.load();
  if (!settings.host) {
    ctx.renderer.emit({
      kind: 'error',
      text: 'No host configured. Run /host <url> first.',
    });
    return;
  }

  setStatus(ctx, { kind: 'connecting', host: settings.host });

  let result;
  try {
    result = await runLoginFlow({
      bodhiUrl: settings.host,
      authServerUrl: settings.authServerUrl,
      callbackPort: settings.callbackPort,
      requested: { mcp_servers: settings.requestedMcps.map(url => ({ url })) },
      opener: ctx.opener,
      log: line => ctx.renderer.emit({ kind: 'info', text: line }),
    });
  } catch (err) {
    setStatus(ctx, {
      kind: 'disconnected',
      reason: 'login failed; see error log',
    });
    ctx.renderer.emit({ kind: 'error', text: `Login flow failed:\n${formatErrorChain(err)}` });
    const preview = (err as { requestPreview?: string }).requestPreview;
    if (preview) {
      ctx.renderer.emit({ kind: 'error', text: `request body preview: ${preview}` });
    }
    const responseBody = (err as { responseBody?: string }).responseBody;
    if (responseBody) {
      ctx.renderer.emit({ kind: 'error', text: `response body: ${responseBody}` });
    }
    if (err instanceof Error && err.stack) {
      ctx.renderer.emit({ kind: 'error', text: err.stack });
    }
    return;
  }

  ctx.tokens = result.tokens;
  await ctx.settings.patch({ tokens: result.tokens });

  setStatus(ctx, { kind: 'authenticating', host: settings.host });
  await ctx.client.authenticate({
    token: result.tokens.accessToken,
    baseUrl: settings.host,
  });
  // Warm the agent's model catalog (see bootstrap.ts:pushTokenToAgent
  // for rationale). Without this, the first prompt after login would
  // fail with "No model selected" because the catalog is only
  // populated by an explicit /models call.
  try {
    await ctx.client.listModels();
  } catch (err) {
    ctx.renderer.emit({
      kind: 'system',
      text: `warm-up listModels failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  setStatus(ctx, {
    kind: 'authenticated',
    host: settings.host,
    modelId: ctx.modelId ?? undefined,
  });
  ctx.renderer.emit({
    kind: 'info',
    text: 'Login successful. Run /models to see available models.',
  });
}
