/**
 * MCP catalog refresh + composed-server bookkeeping for the CLI host.
 *
 * Mirrors `packages/web-acp/src/hooks/useAcpAuth.ts` token-rotation
 * pattern but rooted in the procedural CLI shell rather than React
 * effects:
 *
 *  - on `/login` complete: fetch `GET /bodhi/v1/apps/mcps`, persist
 *    `requestedMcps` from sqlite kv, compose `McpServerHttp[]`, and
 *    push everything into `AppContext`. The first prompt thereafter
 *    sees the live catalog through `composedMcpServers`.
 *
 *  - on token rotation (background refresh in `bootstrap.ts`): re-fetch
 *    + re-compose, and if a session is already open, re-issue
 *    `loadSession` so the worker swaps its `Authorization: Bearer`
 *    headers for every MCP entry. Idempotent against the same
 *    `(token, baseUrl)` key.
 */

import type { McpServerHttp } from '@agentclientprotocol/sdk';
import { listMcpInstances, type McpInstanceView } from './bodhi-client';
import { composeMcpServers } from './compose';
import { authKeyOf, composeSessionMeta } from './session-meta';
import type { AppContext } from '../shell/context';
import { KV_REQUESTED_MCPS } from '../storage/kv-keys';

export interface RefreshMcpCatalogOptions {
  /** Skip the network fetch — use when called from a test with a stub catalog. */
  instances?: McpInstanceView[];
}

export interface RefreshMcpCatalogResult {
  instances: McpInstanceView[];
  composedServers: McpServerHttp[];
}

/**
 * Refresh the MCP catalog for the active session. Called after
 * `/login` and on token rotation. Side effect: writes back into
 * `ctx.mcpInstances`, `ctx.requestedMcps`, `ctx.composedMcpServers`.
 *
 * Returns the freshly composed list so callers can immediately use
 * it (no second AppContext read needed).
 */
export async function refreshMcpCatalog(
  ctx: AppContext,
  opts: RefreshMcpCatalogOptions = {}
): Promise<RefreshMcpCatalogResult> {
  const settings = await ctx.settings.load();
  const host = settings.host;
  const token = ctx.tokens?.accessToken ?? settings.tokens?.accessToken;
  if (!host || !token) {
    ctx.mcpInstances = [];
    ctx.composedMcpServers = [];
    return { instances: [], composedServers: [] };
  }

  let instances = opts.instances;
  if (!instances) {
    try {
      instances = await listMcpInstances({ baseUrl: host, token });
    } catch (err) {
      ctx.renderer.emit({
        kind: 'system',
        text: `MCP catalog fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      instances = [];
    }
  }
  ctx.mcpInstances = instances;
  ctx.requestedMcps = ctx.host.kv.get<string[]>(KV_REQUESTED_MCPS) ?? [];

  const toggles = ctx.sessionId ? await safeReadToggles(ctx) : undefined;
  const composed = composeMcpServers(instances, token, host, toggles ?? undefined);
  ctx.composedMcpServers = composed;
  return { instances, composedServers: composed };
}

/**
 * Compose the `_meta.bodhi` payload to stamp on `session/new` /
 * `session/load`. Pulls from the cached catalog plus persisted
 * `requestedMcps` so callers don't need to re-fetch.
 */
export function buildSessionMeta(ctx: AppContext) {
  return composeSessionMeta(ctx.requestedMcps, ctx.mcpInstances);
}

async function safeReadToggles(ctx: AppContext): Promise<{
  servers: Record<string, boolean>;
  tools: Record<string, Record<string, boolean>>;
} | null> {
  if (!ctx.sessionId) return null;
  try {
    const snap = await ctx.client.getSession(ctx.sessionId);
    return snap.mcpToggles;
  } catch {
    return null;
  }
}

export { authKeyOf };
