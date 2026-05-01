/**
 * In-memory implementations of the agent-package store interfaces. v0
 * does not persist sessions between CLI runs — `/session list` and
 * `/session load` only see what was created in the current process.
 *
 * Filesystem-backed implementations (SQLite or a flat-file journal) are
 * a follow-up; the agent reads via the same `SessionStore` interface so
 * swapping is local to this file.
 */

import {
  EMPTY_MCP_TOGGLES,
  FEATURE_DEFAULTS,
  type FeatureSnapshot,
  type FeatureStore,
  type McpToggleSnapshot,
  type McpToggleStore,
  type SessionEntry,
  type SessionRow,
  type SessionStore,
  type SessionSummary,
  deriveTitle,
  isFeatureKey,
} from '@bodhiapp/web-acp-agent';

export function createInMemorySessionStore(): SessionStore {
  const sessions = new Map<string, SessionRow>();
  const entriesBySession = new Map<string, SessionEntry[]>();

  function ensureSession(id: string, label: string): SessionRow {
    const row = sessions.get(id);
    if (!row) throw new Error(`SessionStore.${label}: unknown session '${id}'`);
    return row;
  }

  function nextSeq(id: string): number {
    return entriesBySession.get(id)?.length ?? 0;
  }

  return {
    async createSession(id, at = Date.now()) {
      sessions.set(id, {
        id,
        createdAt: at,
        updatedAt: at,
        title: null,
        turnCount: 0,
        lastModelId: null,
      });
      entriesBySession.set(id, []);
    },

    async recordNotification(id, notification, at = Date.now()) {
      const session = ensureSession(id, 'recordNotification');
      const seq = nextSeq(id);
      entriesBySession.get(id)!.push({
        sessionId: id,
        seq,
        at,
        kind: 'notification',
        payload: notification,
      });
      session.updatedAt = at;
    },

    async recordTurn(id, userText, finalMessages, modelId, at = Date.now()) {
      const session = ensureSession(id, 'recordTurn');
      const seq = nextSeq(id);
      entriesBySession.get(id)!.push({
        sessionId: id,
        seq,
        at,
        kind: 'turn',
        payload: { userText, finalMessages, modelId },
      });
      const nextTitle = session.title ?? (session.turnCount === 0 ? deriveTitle(userText) : null);
      session.updatedAt = at;
      session.turnCount += 1;
      session.title = nextTitle;
      session.lastModelId = modelId;
    },

    async recordBuiltin(id, payload, at = Date.now()) {
      const session = ensureSession(id, 'recordBuiltin');
      const seq = nextSeq(id);
      entriesBySession.get(id)!.push({
        sessionId: id,
        seq,
        at,
        kind: 'builtin',
        payload,
      });
      session.updatedAt = at;
    },

    async listSummaries(): Promise<SessionSummary[]> {
      return [...sessions.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(row => ({
          id: row.id,
          title: row.title,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          turnCount: row.turnCount,
          lastModelId: row.lastModelId,
        }));
    },

    async readEntries(id) {
      return [...(entriesBySession.get(id) ?? [])];
    },

    async getSession(id) {
      const row = sessions.get(id);
      return row ? { ...row } : undefined;
    },

    async setTitle(id, title) {
      const session = ensureSession(id, 'setTitle');
      session.title = title;
      session.updatedAt = Date.now();
    },

    async deleteSession(id) {
      sessions.delete(id);
      entriesBySession.delete(id);
    },
  };
}

export function createInMemoryFeatureStore(): FeatureStore {
  const flagsBySession = new Map<string, Record<string, boolean>>();
  return {
    async get(sessionId): Promise<FeatureSnapshot> {
      return mergeFeatures(flagsBySession.get(sessionId));
    },
    async set(sessionId, key, value): Promise<FeatureSnapshot> {
      if (!isFeatureKey(key)) {
        throw new Error(`Unknown feature key '${key}'`);
      }
      const current = flagsBySession.get(sessionId) ?? {};
      const next = { ...current, [key]: value };
      flagsBySession.set(sessionId, next);
      return mergeFeatures(next);
    },
    async clear(sessionId): Promise<void> {
      flagsBySession.delete(sessionId);
    },
  };
}

export function createInMemoryMcpToggleStore(): McpToggleStore {
  const togglesBySession = new Map<string, McpToggleSnapshot>();
  function readOrEmpty(sessionId: string): McpToggleSnapshot {
    return (
      togglesBySession.get(sessionId) ?? {
        servers: { ...EMPTY_MCP_TOGGLES.servers },
        tools: {},
      }
    );
  }
  return {
    async get(sessionId): Promise<McpToggleSnapshot> {
      return cloneSnapshot(readOrEmpty(sessionId));
    },
    async setServer(sessionId, serverSlug, value): Promise<McpToggleSnapshot> {
      const current = readOrEmpty(sessionId);
      const next: McpToggleSnapshot = {
        servers: { ...current.servers, [serverSlug]: value },
        tools: cloneToolMap(current.tools),
      };
      togglesBySession.set(sessionId, next);
      return cloneSnapshot(next);
    },
    async setTool(sessionId, serverSlug, toolName, value): Promise<McpToggleSnapshot> {
      const current = readOrEmpty(sessionId);
      const serverTools = { ...(current.tools[serverSlug] ?? {}), [toolName]: value };
      const nextTools = { ...cloneToolMap(current.tools), [serverSlug]: serverTools };
      const next: McpToggleSnapshot = {
        servers: { ...current.servers },
        tools: nextTools,
      };
      togglesBySession.set(sessionId, next);
      return cloneSnapshot(next);
    },
    async clear(sessionId): Promise<void> {
      togglesBySession.delete(sessionId);
    },
  };
}

function mergeFeatures(flags: Record<string, boolean> | undefined): FeatureSnapshot {
  return { ...FEATURE_DEFAULTS, ...(flags ?? {}) };
}

function cloneToolMap(
  tools: Record<string, Record<string, boolean>>
): Record<string, Record<string, boolean>> {
  return Object.fromEntries(Object.entries(tools).map(([slug, m]) => [slug, { ...m }]));
}

function cloneSnapshot(snapshot: McpToggleSnapshot): McpToggleSnapshot {
  return {
    servers: { ...snapshot.servers },
    tools: cloneToolMap(snapshot.tools),
  };
}
