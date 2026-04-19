/**
 * Dev-mode-only vault seed seam.
 *
 * Pattern copied from bodhiapps/zenfs-browser. Playwright injects
 * `window.__zenfsSeed` via `page.addInitScript` before React mounts.
 * On boot we detect the seed, dynamic-import the InMemory vault adapter
 * (so it tree-shakes out of production) and pre-mount `/vault` before any
 * agent tool or UI hook sees the vault state.
 */

import { useEffect, useState } from 'react';

interface ZenfsSeed {
  files: Record<string, string>;
  name: string;
}

interface DevSeedBootState {
  /**
   * Whether we have finished probing for a seed and (if one was present)
   * finished mounting it. Until `ready` is `true`, consumers should hold
   * off on making mount decisions.
   */
  ready: boolean;
  /** The seeded vault name when mounted, else null. */
  seeded: { name: string } | null;
}

export function useDevSeedBoot(): DevSeedBootState {
  const [state, setState] = useState<DevSeedBootState>(() => {
    if (!import.meta.env.DEV) return { ready: true, seeded: null };
    const seed = (window as unknown as { __zenfsSeed?: ZenfsSeed }).__zenfsSeed;
    if (!seed) return { ready: true, seeded: null };
    return { ready: false, seeded: null };
  });

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const seed = (window as unknown as { __zenfsSeed?: ZenfsSeed }).__zenfsSeed;
    if (!seed) return;
    let cancelled = false;
    (async () => {
      const mod = await import('@/fs/in-memory-vault');
      if (cancelled) return;
      await mod.mountInMemoryVault(seed);
      if (cancelled) return;
      setState({ ready: true, seeded: { name: seed.name } });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
