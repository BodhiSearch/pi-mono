/**
 * Per-session MCP toggle store — worker-side companion to
 * `feature-store.ts`. Stores server and per-tool on/off flags keyed
 * by ACP session id.
 *
 * Semantics:
 * - Defaults are **on**; an absent key means "not explicitly
 *   toggled off". Callers merge via `applyMcpToggles` before
 *   composing `McpServerHttp[]` (server toggles) or registering
 *   tools on `InlineAgent.setModel` (tool toggles).
 * - Writes are additive patches, not whole-row replacements, so the
 *   wire contract for `_bodhi/mcp/toggles/set` stays minimal.
 * - On session delete we drop the row; see
 *   `session-store.deleteSession` for the transactional path.
 *
 * See `specs/web-acp/mcp.md` for the public surface returned via
 * `bodhi/getSession` and mutated via `_bodhi/mcp/toggles/set`.
 */
import type { McpTogglesRow, SessionStoreDb } from '../agent/session-store';

/** Snapshot returned to the main thread on `bodhi/getSession`. */
export interface McpToggleSnapshot {
  servers: Record<string, boolean>;
  tools: Record<string, Record<string, boolean>>;
}

export const EMPTY_MCP_TOGGLES: McpToggleSnapshot = Object.freeze({
  servers: Object.freeze({}) as Record<string, boolean>,
  tools: Object.freeze({}) as Record<string, Record<string, boolean>>,
}) as McpToggleSnapshot;

export interface McpToggleStore {
  get(sessionId: string): Promise<McpToggleSnapshot>;
  setServer(sessionId: string, serverSlug: string, value: boolean): Promise<McpToggleSnapshot>;
  setTool(
    sessionId: string,
    serverSlug: string,
    toolName: string,
    value: boolean
  ): Promise<McpToggleSnapshot>;
  clear(sessionId: string): Promise<void>;
}

function rowToSnapshot(row: McpTogglesRow | undefined): McpToggleSnapshot {
  if (!row) return { servers: {}, tools: {} };
  return {
    servers: { ...row.servers },
    tools: Object.fromEntries(
      Object.entries(row.tools).map(([slug, toolMap]) => [slug, { ...toolMap }])
    ),
  };
}

export function createMcpToggleStore(db: SessionStoreDb): McpToggleStore {
  return {
    async get(sessionId) {
      const row = await db.mcpToggles.get(sessionId);
      return rowToSnapshot(row);
    },

    async setServer(sessionId, serverSlug, value) {
      const now = Date.now();
      const current = await db.mcpToggles.get(sessionId);
      const nextServers = { ...(current?.servers ?? {}), [serverSlug]: value };
      const next: McpTogglesRow = {
        sessionId,
        servers: nextServers,
        tools: current?.tools ?? {},
        updatedAt: now,
      };
      await db.mcpToggles.put(next);
      return rowToSnapshot(next);
    },

    async setTool(sessionId, serverSlug, toolName, value) {
      const now = Date.now();
      const current = await db.mcpToggles.get(sessionId);
      const currentTools = current?.tools ?? {};
      const serverTools = { ...(currentTools[serverSlug] ?? {}), [toolName]: value };
      const nextTools: Record<string, Record<string, boolean>> = {
        ...currentTools,
        [serverSlug]: serverTools,
      };
      const next: McpTogglesRow = {
        sessionId,
        servers: current?.servers ?? {},
        tools: nextTools,
        updatedAt: now,
      };
      await db.mcpToggles.put(next);
      return rowToSnapshot(next);
    },

    async clear(sessionId) {
      await db.mcpToggles.delete(sessionId);
    },
  };
}

/**
 * True iff the given server slug is *enabled* (not explicitly turned
 * off) according to the snapshot. Absent entries are treated as on.
 */
export function isServerEnabled(
  toggles: McpToggleSnapshot | undefined,
  serverSlug: string
): boolean {
  if (!toggles) return true;
  const explicit = toggles.servers?.[serverSlug];
  return explicit !== false;
}

/**
 * True iff the given tool on the given server is enabled. Absent
 * entries are treated as on; the server-level toggle takes
 * precedence (an off server implies all its tools are off, which
 * callers typically handle upstream by skipping the server entirely).
 */
export function isToolEnabled(
  toggles: McpToggleSnapshot | undefined,
  serverSlug: string,
  toolName: string
): boolean {
  if (!toggles) return true;
  if (!isServerEnabled(toggles, serverSlug)) return false;
  const perServer = toggles.tools?.[serverSlug];
  if (!perServer) return true;
  return perServer[toolName] !== false;
}
