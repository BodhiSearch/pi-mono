/**
 * `/session` user-facing surface.
 *
 * Subcommands:
 *   - `list` (default): inventory of stored sessions.
 *   - `new`: open a fresh session bound to the current cwd; composes
 *     `mcpServers` + `_meta.bodhi` from the live MCP catalog.
 *   - `load <id>`: replay an existing session — fetch the snapshot,
 *     compose `mcpServers` with the *stored* toggles, dispatch
 *     `load-start`/`load-end` through the StreamController so the
 *     transcript appears, and re-apply the persisted model id.
 *   - `delete <id>` / `rm <id>`: drop a session from the store.
 *
 * The `load` path is intentionally chunky because it has to mirror
 * web-acp's `useAcpSession.loadSession` end-to-end: pre-fetch the
 * snapshot, swap server toggles in/out, replay messages, restore
 * model selection. See
 * `packages/web-acp/src/hooks/useAcpSession.ts:180-240`.
 */

import type { AppContext } from '../shell/context';
import type { SlashCommand } from '../shell/registry';
import type { AgentMessage } from '../acp/streaming-reducer';
import { buildSessionMeta, refreshMcpCatalog } from '../mcp/catalog';
import { composeMcpServers } from '../mcp/compose';
import { KV_LAST_MODEL_ID } from '../storage/kv-keys';

export const sessionCommand: SlashCommand = {
  name: 'session',
  description: 'Inspect or switch ACP sessions.',
  usage: '/session [list|new|load <id>|delete <id>]',
  async handler(ctx, args) {
    const [sub, ...rest] = args;
    const action = sub ?? 'list';
    switch (action) {
      case 'list':
        return listSessions(ctx);
      case 'new':
        return newSession(ctx);
      case 'load':
        return loadSession(ctx, rest[0]);
      case 'delete':
      case 'rm':
        return deleteSession(ctx, rest[0]);
      default:
        ctx.renderer.emit({ kind: 'error', text: `Unknown /session action '${action}'.` });
    }
  },
};

async function listSessions(ctx: AppContext): Promise<void> {
  const sessions = await ctx.client.listSessions();
  if (sessions.length === 0) {
    ctx.renderer.emit({ kind: 'info', text: 'No sessions yet.' });
    return;
  }
  const lines = sessions.map(
    s => `  ${s.id.slice(0, 12)}…  turns=${s.turnCount}  ${s.title ?? '(untitled)'}`
  );
  ctx.renderer.emit({
    kind: 'info',
    text: `Sessions (${sessions.length}):\n${lines.join('\n')}`,
  });
}

async function newSession(ctx: AppContext): Promise<void> {
  const sessionMeta = buildSessionMeta(ctx);
  const result = await ctx.client.newSession(ctx.cwd, ctx.composedMcpServers, sessionMeta);
  ctx.sessionId = result.sessionId;
  ctx.renderer.emit({ kind: 'info', text: `Created session ${result.sessionId}` });
}

async function loadSession(ctx: AppContext, idOrPrefix: string | undefined): Promise<void> {
  if (!idOrPrefix) {
    ctx.renderer.emit({ kind: 'error', text: 'Usage: /session load <id|prefix>' });
    return;
  }

  // Allow prefix matching so the user can paste a truncated id from
  // `/session list` (which renders the first 12 chars). Full ids are
  // accepted as-is.
  const id = await resolveSessionId(ctx, idOrPrefix);
  if (!id) return;

  // Auth-loss guard: cancel any in-flight turn before swapping
  // sessions. The agent's prompt-driver tolerates a cancel + load
  // back-to-back; we just want the user to see a clean slate.
  if (ctx.sessionId && ctx.stream.getState().isStreaming) {
    try {
      await ctx.client.cancel(ctx.sessionId);
    } catch {
      // ignore: already cancelled or never started
    }
  }

  ctx.stream.dispatch({ type: 'load-start' });
  try {
    // Fetch the snapshot before `loadSession` so we can:
    //  1. compose `mcpServers` with the persisted per-session
    //     toggles (otherwise we'd briefly enable every server),
    //  2. replay `messages` into the renderer,
    //  3. restore `lastModelId` for the next prompt.
    const snapshot = await ctx.client.getSession(id);

    // Refresh the catalog under the current token so headers are
    // fresh, then compose with the snapshot's toggles.
    const settings = await ctx.settings.load();
    const host = settings.host;
    const token = ctx.tokens?.accessToken ?? settings.tokens?.accessToken;

    let composedServers = ctx.composedMcpServers;
    if (host && token) {
      // Re-fetch first so newly-provisioned MCPs surface even if the
      // catalog hadn't been pulled yet.
      await refreshMcpCatalog(ctx);
      composedServers = composeMcpServers(
        ctx.mcpInstances,
        token,
        host,
        snapshot.mcpToggles ?? { servers: {}, tools: {} }
      );
      ctx.composedMcpServers = composedServers;
    }

    const sessionMeta = buildSessionMeta(ctx);
    await ctx.client.loadSession(id, ctx.cwd, composedServers, sessionMeta);
    ctx.sessionId = id;

    const messages = (snapshot.messages ?? []) as AgentMessage[];
    ctx.stream.dispatch({ type: 'load-end', messages });

    if (snapshot.lastModelId) {
      ctx.modelId = snapshot.lastModelId;
      ctx.host.kv.set(KV_LAST_MODEL_ID, snapshot.lastModelId);
    }

    ctx.renderer.emit({
      kind: 'info',
      text: `Loaded session ${id} (${messages.length} message(s)${snapshot.lastModelId ? `, model=${snapshot.lastModelId}` : ''}).`,
    });
  } catch (err) {
    ctx.stream.dispatch({ type: 'load-end' });
    ctx.renderer.emit({
      kind: 'error',
      text: `Failed to load session: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function deleteSession(ctx: AppContext, idOrPrefix: string | undefined): Promise<void> {
  if (!idOrPrefix) {
    ctx.renderer.emit({ kind: 'error', text: 'Usage: /session delete <id|prefix>' });
    return;
  }
  const id = await resolveSessionId(ctx, idOrPrefix);
  if (!id) return;
  const deleted = await ctx.client.deleteSession(id);
  ctx.renderer.emit({
    kind: 'info',
    text: deleted ? `Deleted session ${id}` : `No session ${id}`,
  });
  if (deleted && ctx.sessionId === id) {
    ctx.sessionId = null;
    ctx.stream.dispatch({ type: 'reset' });
  }
}

/**
 * Look up a session by either full id (returned as-is) or a prefix
 * (resolved via `listSessions` with unambiguous match). Emits an error
 * and returns `null` when there is no match or multiple matches; the
 * caller short-circuits on `null`.
 */
async function resolveSessionId(ctx: AppContext, idOrPrefix: string): Promise<string | null> {
  // Heuristic: full UUIDs we mint are 36 chars with dashes. Skip the
  // listSessions round-trip for those.
  const looksFull = idOrPrefix.length >= 32 && idOrPrefix.includes('-');
  if (looksFull) return idOrPrefix;

  let sessions: Array<{ id: string }>;
  try {
    sessions = await ctx.client.listSessions();
  } catch (err) {
    ctx.renderer.emit({
      kind: 'error',
      text: `Failed to look up session: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }
  const matches = sessions.filter(s => s.id.startsWith(idOrPrefix));
  if (matches.length === 0) {
    ctx.renderer.emit({
      kind: 'error',
      text: `No session matches '${idOrPrefix}'.`,
    });
    return null;
  }
  if (matches.length > 1) {
    ctx.renderer.emit({
      kind: 'error',
      text: `Multiple sessions match '${idOrPrefix}'. Be more specific.`,
    });
    return null;
  }
  return matches[0].id;
}
