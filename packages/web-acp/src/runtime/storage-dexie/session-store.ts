import { deriveTitle, type SessionStore, type TurnPayload } from '@bodhiapp/web-acp-agent';
import type { SessionStoreDb } from './db';
import { openSessionDb, type OpenSessionDbOptions } from './db';

/**
 * Browser-side concrete implementation of the agent-package
 * `SessionStore` interface, backed by Dexie/IndexedDB.
 */
export function createSessionStore(options: OpenSessionDbOptions = {}): SessionStore {
  return createStoreFromDb(openSessionDb(options));
}

export function createStoreFromDb(db: SessionStoreDb): SessionStore {
  return {
    async createSession(id, at = Date.now()) {
      await db.sessions.put({
        id,
        createdAt: at,
        updatedAt: at,
        title: null,
        turnCount: 0,
        lastModelId: null,
      });
    },

    async recordNotification(id, notification, at = Date.now()) {
      await db.transaction('rw', db.sessions, db.entries, async () => {
        const session = await db.sessions.get(id);
        if (!session) {
          throw new Error(`SessionStore.recordNotification: unknown session '${id}'`);
        }
        const seq = await nextSeq(db, id);
        await db.entries.put({
          sessionId: id,
          seq,
          at,
          kind: 'notification',
          payload: notification,
        });
        await db.sessions.update(id, { updatedAt: at });
      });
    },

    async recordTurn(id, userText, finalMessages, modelId, at = Date.now()) {
      await db.transaction('rw', db.sessions, db.entries, async () => {
        const session = await db.sessions.get(id);
        if (!session) {
          throw new Error(`SessionStore.recordTurn: unknown session '${id}'`);
        }
        const seq = await nextSeq(db, id);
        const payload: TurnPayload = { userText, finalMessages, modelId };
        await db.entries.put({ sessionId: id, seq, at, kind: 'turn', payload });
        const nextTitle = session.title ?? (session.turnCount === 0 ? deriveTitle(userText) : null);
        await db.sessions.update(id, {
          updatedAt: at,
          turnCount: session.turnCount + 1,
          title: nextTitle,
          lastModelId: modelId,
        });
      });
    },

    async recordBuiltin(id, payload, at = Date.now()) {
      await db.transaction('rw', db.sessions, db.entries, async () => {
        const session = await db.sessions.get(id);
        if (!session) {
          throw new Error(`SessionStore.recordBuiltin: unknown session '${id}'`);
        }
        const seq = await nextSeq(db, id);
        await db.entries.put({ sessionId: id, seq, at, kind: 'builtin', payload });
        // Bumps `updatedAt` so the picker reflects activity, but does
        // NOT bump `turnCount` (this isn't a model turn) and does NOT
        // claim the title slot (the first real prompt still wins).
        await db.sessions.update(id, { updatedAt: at });
      });
    },

    async listSummaries() {
      const rows = await db.sessions.orderBy('updatedAt').reverse().toArray();
      return rows.map(row => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        turnCount: row.turnCount,
        lastModelId: row.lastModelId,
      }));
    },

    async readEntries(id) {
      return db.entries.where('sessionId').equals(id).sortBy('seq');
    },

    async getSession(id) {
      return db.sessions.get(id);
    },

    async setTitle(id, title) {
      await db.sessions.update(id, { title, updatedAt: Date.now() });
    },

    async deleteSession(id) {
      await db.transaction('rw', db.sessions, db.entries, db.preferences, async () => {
        await db.entries.where('sessionId').equals(id).delete();
        await db.preferences.where('sessionId').equals(id).delete();
        await db.sessions.delete(id);
      });
    },
  };
}

async function nextSeq(db: SessionStoreDb, sessionId: string): Promise<number> {
  // Called from inside a `rw` transaction on `entries`. Dexie serialises
  // writes on a table within a transaction, so `count()` + `seq = count`
  // is monotonic as long as entries for a given session are never
  // individually deleted (only whole-session deletion).
  return db.entries.where('sessionId').equals(sessionId).count();
}
