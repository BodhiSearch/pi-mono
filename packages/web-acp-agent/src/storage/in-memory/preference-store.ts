import type { PreferenceStore } from '../preference-store';

export function createInMemoryPreferenceStore(): PreferenceStore {
  const rows = new Map<string, Map<string, unknown>>();

  function bag(sessionId: string): Map<string, unknown> {
    let b = rows.get(sessionId);
    if (!b) {
      b = new Map();
      rows.set(sessionId, b);
    }
    return b;
  }

  return {
    async get(sessionId, key) {
      return rows.get(sessionId)?.get(key);
    },
    async set(sessionId, key, value) {
      bag(sessionId).set(key, value);
    },
    async delete(sessionId, key) {
      rows.get(sessionId)?.delete(key);
    },
    async list(sessionId) {
      const b = rows.get(sessionId);
      if (!b) return {};
      return Object.fromEntries(b);
    },
    async clearSession(sessionId) {
      rows.delete(sessionId);
    },
  };
}
