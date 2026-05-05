import type {
  ExtensionPayload,
  SessionEntry,
  SessionRow,
  SessionStore,
  SessionSummary,
} from '../session-store';
import { deriveTitle } from '../session-store';

export function createInMemorySessionStore(): SessionStore {
  const rows = new Map<string, SessionRow>();
  const entries = new Map<string, SessionEntry[]>();

  function ensure(id: string, label: string): SessionRow {
    const row = rows.get(id);
    if (!row) throw new Error(`SessionStore.${label}: unknown session '${id}'`);
    return row;
  }

  function nextSeq(id: string): number {
    return entries.get(id)?.length ?? 0;
  }

  return {
    async createSession(id, at = Date.now()) {
      if (rows.has(id)) return;
      rows.set(id, {
        id,
        createdAt: at,
        updatedAt: at,
        title: null,
        turnCount: 0,
        lastModelId: null,
      });
      entries.set(id, []);
    },

    async recordNotification(id, notification, at = Date.now()) {
      const row = ensure(id, 'recordNotification');
      const list = entries.get(id) ?? [];
      list.push({
        sessionId: id,
        seq: nextSeq(id),
        at,
        kind: 'notification',
        payload: notification,
      });
      entries.set(id, list);
      rows.set(id, { ...row, updatedAt: at });
    },

    async recordTurn(id, userText, finalMessages, modelId, at = Date.now()) {
      const row = ensure(id, 'recordTurn');
      const list = entries.get(id) ?? [];
      list.push({
        sessionId: id,
        seq: nextSeq(id),
        at,
        kind: 'turn',
        payload: { userText, finalMessages, modelId },
      });
      entries.set(id, list);
      rows.set(id, {
        ...row,
        updatedAt: at,
        turnCount: row.turnCount + 1,
        title: row.title ?? (row.turnCount === 0 ? deriveTitle(userText) : null),
        lastModelId: modelId,
      });
    },

    async recordBuiltin(id, payload, at = Date.now()) {
      const row = ensure(id, 'recordBuiltin');
      const list = entries.get(id) ?? [];
      list.push({ sessionId: id, seq: nextSeq(id), at, kind: 'builtin', payload });
      entries.set(id, list);
      rows.set(id, { ...row, updatedAt: at });
    },

    async recordExtension(id, payload, at = Date.now()) {
      const row = ensure(id, 'recordExtension');
      const list = entries.get(id) ?? [];
      const seq = nextSeq(id);
      list.push({ sessionId: id, seq, at, kind: 'extension', payload });
      entries.set(id, list);
      rows.set(id, { ...row, updatedAt: at });
      return seq;
    },

    async setExtensionLabel(id, seq, label) {
      const list = entries.get(id) ?? [];
      const idx = list.findIndex(e => e.seq === seq && e.kind === 'extension');
      if (idx === -1) return;
      const prev = list[idx];
      const prevPayload = prev.payload as ExtensionPayload;
      const nextPayload: ExtensionPayload = {
        ...prevPayload,
        ...(label === undefined ? { label: undefined } : { label }),
      };
      list[idx] = { ...prev, payload: nextPayload };
      entries.set(id, list);
    },

    async listSummaries(): Promise<SessionSummary[]> {
      return [...rows.values()]
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

    async listSummariesPage({ page, perPage }) {
      const sorted = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      const total = sorted.length;
      const start = Math.max(0, (page - 1) * perPage);
      const slice = sorted.slice(start, start + perPage).map(row => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        turnCount: row.turnCount,
        lastModelId: row.lastModelId,
      }));
      return { rows: slice, total };
    },

    async readEntries(id): Promise<SessionEntry[]> {
      return [...(entries.get(id) ?? [])];
    },

    async getSession(id) {
      const row = rows.get(id);
      return row ? { ...row } : undefined;
    },

    async setTitle(id, title) {
      const row = ensure(id, 'setTitle');
      rows.set(id, { ...row, title: title ?? null, updatedAt: Date.now() });
    },

    async deleteSession(id) {
      rows.delete(id);
      entries.delete(id);
    },
  };
}
