/**
 * Pure helper for the session picker: turns a flat `SessionSummary[]` into a
 * depth-tagged forest grouped by topmost-ancestor (the "root").
 *
 * Display rule (intentional, not arbitrary):
 *   - Each session walks up its `parentSessionPath` chain to find its root
 *     (the topmost ancestor whose parent is missing or absent from the list).
 *   - The root renders at depth 0; **every** descendant — fork, fork-of-fork,
 *     grandfork — renders at depth 1 immediately under its root, in insertion
 *     order. The picker is a narrow dropdown; deep tree rendering would
 *     produce indent ladders that don't fit the surface. A flat one-level
 *     grouping is enough to communicate "this session belongs to that
 *     conversation tree."
 *   - Orphans (parent missing from input — e.g. parent was deleted earlier)
 *     promote to root.
 *   - Cycle guard: if walking the parent chain ever revisits a session id,
 *     the cycle is broken at that point and the session is treated as a
 *     root. Shouldn't happen with UUIDv7 + atomic forks but cheap insurance.
 */

import type { SessionSummary } from '@/worker-agent';

export interface ForestNode {
  summary: SessionSummary;
  depth: number;
}

export function buildSessionForest(list: SessionSummary[]): ForestNode[] {
  const byId = new Map(list.map(s => [s.id, s]));

  // Resolve each session to its topmost ancestor present in the list.
  function rootOf(s: SessionSummary): SessionSummary {
    const seen = new Set<string>();
    let cur = s;
    while (true) {
      if (seen.has(cur.id)) return cur; // cycle break
      seen.add(cur.id);
      const parentId = cur.parentSessionPath;
      if (!parentId || parentId === cur.id) return cur;
      const parent = byId.get(parentId);
      if (!parent) return cur; // orphan — current is the root we can see
      cur = parent;
    }
  }

  // Group sessions by their root id, preserving insertion order on both
  // levels so the user sees the same row order Dexie returned.
  const groupByRoot = new Map<string, { root: SessionSummary; descendants: SessionSummary[] }>();
  for (const s of list) {
    const root = rootOf(s);
    let bucket = groupByRoot.get(root.id);
    if (!bucket) {
      bucket = { root, descendants: [] };
      groupByRoot.set(root.id, bucket);
    }
    if (s.id !== root.id) bucket.descendants.push(s);
  }

  const out: ForestNode[] = [];
  for (const { root, descendants } of groupByRoot.values()) {
    out.push({ summary: root, depth: 0 });
    for (const d of descendants) out.push({ summary: d, depth: 1 });
  }
  return out;
}
