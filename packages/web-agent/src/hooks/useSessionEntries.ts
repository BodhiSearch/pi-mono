/**
 * Reactive entry list for a single session.
 *
 * Mirrors `useSessionsList`: opens a main-thread `DexieSessionStore` against
 * the same IDB DB the Worker writes to, then subscribes to `liveQuery` so
 * forks / appends propagate without an RPC round-trip. Returns an empty
 * array when `sessionId` is null or no entries exist yet.
 */

import { useLiveQuery } from 'dexie-react-hooks';
import { DexieSessionStore, type SessionEntry } from '@/web-agent';

const EMPTY: SessionEntry[] = [];

let mainStore: DexieSessionStore | null = null;
function getMainStore(): DexieSessionStore {
  if (!mainStore) mainStore = new DexieSessionStore();
  return mainStore;
}

export function useSessionEntries(sessionId: string | null): SessionEntry[] {
  const store = getMainStore();
  const result = useLiveQuery(
    () => (sessionId ? store.getEntries(sessionId) : Promise.resolve(EMPTY)),
    [store, sessionId],
    EMPTY
  );
  return result ?? EMPTY;
}
