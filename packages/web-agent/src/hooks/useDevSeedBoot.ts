/**
 * Dev-mode-only vault seed reader.
 *
 * After M4 we don't mount anything on the main thread — the seed flows
 * into the agent Worker's init message and the InMemory ZenFS backend is
 * mounted Worker-side. This hook just surfaces the seed (or its absence)
 * so VaultProvider can wait for the Worker mount to confirm before
 * announcing `mounted` to consumers.
 */

import { useEffect, useState } from 'react';
import { readDevSeed } from '@/fs/in-memory-vault';

interface DevSeedBootState {
  /**
   * Whether we have finished probing for a seed. In production this is
   * synchronously `true`. In dev with a seed present, it stays `false`
   * until the Worker confirms the mount.
   */
  ready: boolean;
  /** The seeded vault name when present, else null. */
  seeded: { name: string } | null;
}

export function useDevSeedBoot(workerMounted: boolean): DevSeedBootState {
  const [state, setState] = useState<DevSeedBootState>(() => {
    if (!import.meta.env.DEV) return { ready: true, seeded: null };
    const seed = readDevSeed();
    if (!seed) return { ready: true, seeded: null };
    return { ready: false, seeded: null };
  });

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const seed = readDevSeed();
    if (!seed) return;
    if (!workerMounted) return;
    let cancelled = false;
    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setState({ ready: true, seeded: { name: seed.name } });
    })();
    return () => {
      cancelled = true;
    };
  }, [workerMounted]);

  return state;
}
