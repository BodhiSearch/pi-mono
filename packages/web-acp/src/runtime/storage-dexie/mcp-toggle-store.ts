import type { McpToggleSnapshot, McpToggleStore, McpTogglesRow } from '@bodhiapp/web-acp-agent';
import type { SessionStoreDb } from './db';

/**
 * Dexie-backed concrete implementation of the agent-package
 * `McpToggleStore` interface for the browser host. Tables live
 * alongside the session store (Dexie v3); per-session deletion is
 * transactional inside `createSessionStore.deleteSession`.
 */
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
