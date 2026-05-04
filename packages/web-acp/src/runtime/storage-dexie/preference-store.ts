import type { PreferenceStore } from '@bodhiapp/web-acp-agent';
import type { SessionStoreDb } from './db';

export function createPreferenceStore(db: SessionStoreDb): PreferenceStore {
  return {
    async get(sessionId, key) {
      const row = await db.preferences.get([sessionId, key]);
      return row?.value;
    },
    async set(sessionId, key, value) {
      await db.preferences.put({ sessionId, key, value, updatedAt: Date.now() });
    },
    async delete(sessionId, key) {
      await db.preferences.delete([sessionId, key]);
    },
    async list(sessionId) {
      const rows = await db.preferences.where('sessionId').equals(sessionId).toArray();
      const out: Record<string, unknown> = {};
      for (const row of rows) out[row.key] = row.value;
      return out;
    },
    async clearSession(sessionId) {
      await db.preferences.where('sessionId').equals(sessionId).delete();
    },
  };
}
