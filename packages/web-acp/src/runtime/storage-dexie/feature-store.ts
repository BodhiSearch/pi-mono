import {
  FEATURE_DEFAULTS,
  isFeatureKey,
  type FeatureSnapshot,
  type FeatureStore,
} from '@bodhiapp/web-acp-agent';
import type { SessionStoreDb } from './db';

/**
 * Dexie-backed concrete implementation of the agent-package
 * `FeatureStore` interface for the browser host. Reads merge persisted
 * overrides on top of `FEATURE_DEFAULTS`; writes only persist the
 * override patch to keep the wire shape minimal.
 */
export function createFeatureStore(db: SessionStoreDb): FeatureStore {
  return {
    async get(sessionId) {
      const row = await db.features.get(sessionId);
      return mergeWithDefaults(row?.flags);
    },

    async set(sessionId, key, value) {
      if (!isFeatureKey(key)) {
        throw new Error(`Unknown feature key '${key}'`);
      }
      const now = Date.now();
      const current = (await db.features.get(sessionId))?.flags ?? {};
      const nextFlags = { ...current, [key]: value };
      await db.features.put({ sessionId, flags: nextFlags, updatedAt: now });
      return mergeWithDefaults(nextFlags);
    },

    async clear(sessionId) {
      await db.features.delete(sessionId);
    },
  };
}

function mergeWithDefaults(flags: Record<string, boolean> | undefined): FeatureSnapshot {
  return { ...FEATURE_DEFAULTS, ...(flags ?? {}) };
}
