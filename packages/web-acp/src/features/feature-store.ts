/**
 * Per-session feature toggle store.
 *
 * Features are plain `boolean` flags keyed by string. Defaults live in
 * `FEATURE_DEFAULTS`; on every `get()` we merge the persisted flags on
 * top of the defaults so newly-introduced features show up without a
 * migration. `set()` only writes the override so the default surface
 * remains observable via deletion later if needed.
 *
 * Storage rides on the Dexie database used by `SessionStore` (`features`
 * table, added in version 2). See `src/agent/session-store.ts`.
 */
import type { SessionStoreDb } from '../agent/session-store';

export interface FeatureDefaults {
  bashEnabled: boolean;
  forceToolCall: boolean;
}

export const FEATURE_DEFAULTS: FeatureDefaults = {
  bashEnabled: true,
  forceToolCall: false,
};

export type FeatureKey = keyof FeatureDefaults;

export function isFeatureKey(key: string): key is FeatureKey {
  return key in FEATURE_DEFAULTS;
}

export interface FeatureSnapshot extends FeatureDefaults {
  [key: string]: boolean;
}

export interface FeatureStore {
  get(sessionId: string): Promise<FeatureSnapshot>;
  set(sessionId: string, key: string, value: boolean): Promise<FeatureSnapshot>;
  clear(sessionId: string): Promise<void>;
}

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
