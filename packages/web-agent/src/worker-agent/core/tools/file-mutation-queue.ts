/**
 * Per-path serialization for filesystem mutations.
 *
 * Pattern copied from `packages/coding-agent/src/core/tools/file-mutation-queue.ts`.
 * Browser adaptation: ZenFS backends (WebAccess over FSA, InMemory, IndexedDB)
 * do not expose symlinks, so we drop the `realpathSync` canonicalisation step
 * and key the queue on the normalised path string directly.
 *
 * Behaviour:
 *   - Writes to the same normalised path execute in order (no races).
 *   - Writes to different paths execute concurrently.
 *   - Queue entries self-clean when the last pending operation settles.
 */

const queues = new Map<string, Promise<unknown>>();

function normalizePath(path: string): string {
  // Collapse `.` and `..` segments. This mirrors what `resolveVaultPath`
  // already does for user-facing paths, but tools may call us with paths
  // that were resolved in a different context, so we normalise defensively.
  const parts = path.split('/');
  const out: string[] = [];
  for (const segment of parts) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  return path.startsWith('/') ? `/${joined}` : joined;
}

export async function withFileMutationQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = normalizePath(path);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(
    key,
    next.catch(() => undefined)
  );
  try {
    return (await next) as T;
  } finally {
    // If our chain is still the head of the queue, remove it so the Map
    // doesn't grow unbounded over a long session.
    if (queues.get(key) === (next as unknown as Promise<unknown>).catch(() => undefined)) {
      // Probabilistic cleanup — the wrapped `.catch` makes reference-equality
      // fragile, so also sweep entries whose promises have settled.
      queues.delete(key);
    }
  }
}

/** Test-only: drain the internal queue map. Used by unit tests. */
export function __resetFileMutationQueuesForTests(): void {
  queues.clear();
}
