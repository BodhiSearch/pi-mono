/**
 * Small tree/DAG helpers over `SessionEntry[]`. Kept as pure functions so
 * the `SessionStore` implementations + SessionManager can share them.
 */

import type { SessionEntry } from './types';

/**
 * Walks the parentId chain from `targetId` back to its root and returns the
 * path in root-to-target order (inclusive).
 *
 * Throws if `targetId` isn't present in `entries`, or if the chain cannot be
 * resolved (dangling parentId points at a missing entry).
 */
export function walkPathToEntry(entries: SessionEntry[], targetId: string): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);
  const target = byId.get(targetId);
  if (!target) throw new Error(`Entry not found: ${targetId}`);

  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = target;
  while (current) {
    if (seen.has(current.id)) {
      throw new Error(`Cycle detected at entry ${current.id}`);
    }
    seen.add(current.id);
    path.unshift(current);
    if (current.parentId === null || current.parentId === current.id) break;
    const parent = byId.get(current.parentId);
    if (!parent) {
      throw new Error(`Dangling parentId ${current.parentId} on entry ${current.id}`);
    }
    current = parent;
  }
  return path;
}
