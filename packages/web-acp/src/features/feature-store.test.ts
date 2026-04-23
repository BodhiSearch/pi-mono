import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionStoreDb } from '@/agent/session-store';
import {
  createFeatureStore,
  FEATURE_DEFAULTS,
  isFeatureKey,
  type FeatureStore,
} from './feature-store';

describe('FeatureStore', () => {
  let db: SessionStoreDb;
  let store: FeatureStore;

  beforeEach(() => {
    db = new SessionStoreDb(`web-acp-features-${crypto.randomUUID()}`);
    store = createFeatureStore(db);
  });

  it('returns defaults for an unknown session', async () => {
    const snapshot = await store.get('session-a');
    expect(snapshot).toEqual({ ...FEATURE_DEFAULTS });
  });

  it('persists overrides and merges them over the defaults', async () => {
    const afterSet = await store.set('session-a', 'bashEnabled', false);
    expect(afterSet.bashEnabled).toBe(false);
    expect(afterSet.forceToolCall).toBe(FEATURE_DEFAULTS.forceToolCall);

    const snapshot = await store.get('session-a');
    expect(snapshot.bashEnabled).toBe(false);
    expect(snapshot.forceToolCall).toBe(FEATURE_DEFAULTS.forceToolCall);
  });

  it('writes each flag independently without disturbing siblings', async () => {
    await store.set('session-b', 'forceToolCall', true);
    const snapshot = await store.set('session-b', 'bashEnabled', false);
    expect(snapshot.forceToolCall).toBe(true);
    expect(snapshot.bashEnabled).toBe(false);
  });

  it('rejects unknown feature keys', async () => {
    await expect(store.set('session-c', 'unknown' as never, true)).rejects.toThrow(
      /Unknown feature/
    );
  });

  it('clears overrides back to defaults', async () => {
    await store.set('session-d', 'bashEnabled', false);
    await store.clear('session-d');
    const snapshot = await store.get('session-d');
    expect(snapshot).toEqual({ ...FEATURE_DEFAULTS });
  });

  it('isFeatureKey gates known keys only', () => {
    expect(isFeatureKey('bashEnabled')).toBe(true);
    expect(isFeatureKey('forceToolCall')).toBe(true);
    expect(isFeatureKey('somethingElse')).toBe(false);
  });
});
