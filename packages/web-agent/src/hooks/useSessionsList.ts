/**
 * Reactive session list for the picker UI.
 *
 * Opens its own main-thread `DexieSessionStore` singleton against the same
 * `web-agent` IDB database the Worker writes to. Dexie's `liveQuery` fans
 * invalidations out over BroadcastChannel, so whenever the Worker commits
 * a session write (new, append, rename, delete) — or another tab does —
 * the hook re-renders with the fresh summaries.
 *
 * No RPC round-trip for reads. The Worker stays the authoritative writer.
 */

import { useLiveQuery } from 'dexie-react-hooks';
import { DexieSessionStore, type SessionSummary } from '@/worker-agent';

const EMPTY: SessionSummary[] = [];

let mainStore: DexieSessionStore | null = null;
function getMainStore(): DexieSessionStore {
  if (!mainStore) mainStore = new DexieSessionStore();
  return mainStore;
}

export function useSessionsList(): SessionSummary[] {
  const store = getMainStore();
  const result = useLiveQuery(() => store.listSessions(), [store], EMPTY);
  return result ?? EMPTY;
}
