/**
 * Orchestrates vault mounting: prefer dev-seed (tests), else FSA handle.
 *
 * Returns a single status the UI can render from. When `status === 'mounted'`
 * the vault is usable by the agent's filesystem tools via the ZenFS APIs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isVaultMounted, mountVault, unmountVault } from '@/web-agent/fs/zenfs-provider';
import { useDevSeedBoot } from '@/hooks/useDevSeedBoot';
import { useDirectoryHandle } from '@/hooks/useDirectoryHandle';

export type VaultMountStatus =
  | 'initializing'
  | 'empty'
  | 'prompt'
  | 'mounting'
  | 'mounted'
  | 'error';

export interface UseVaultMountResult {
  status: VaultMountStatus;
  /** Display name — seeded name for tests, handle.name for real folder, null when empty. */
  name: string | null;
  errorMessage: string | null;
  openDirectory: () => Promise<void>;
  restoreAccess: () => Promise<void>;
  closeDirectory: () => Promise<void>;
}

type MountStateTag = 'idle' | 'mounting' | 'mounted' | 'error';

export function useVaultMount(): UseVaultMountResult {
  const devSeed = useDevSeedBoot();
  const handle = useDirectoryHandle();

  const [mountState, setMountState] = useState<{
    tag: MountStateTag;
    message: string | null;
  }>({ tag: 'idle', message: null });

  // Mount side-effect. All setState calls are async (inside awaited chains)
  // to satisfy react-hooks/set-state-in-effect — the effect never mutates
  // state synchronously in its body.
  useEffect(() => {
    if (!devSeed.ready) return;

    let cancelled = false;

    (async () => {
      if (devSeed.seeded) {
        // Seed path: mountInMemoryVault already ran inside useDevSeedBoot's
        // effect, so the vfs is already populated. Reflect that here via an
        // awaited microtask so the setState is not synchronous within the
        // effect body.
        await Promise.resolve();
        if (cancelled) return;
        setMountState({ tag: 'mounted', message: null });
        return;
      }
      if (handle.status !== 'ready' || !handle.handle) {
        return;
      }
      await Promise.resolve();
      if (cancelled) return;
      setMountState({ tag: 'mounting', message: null });
      try {
        await mountVault(handle.handle);
        if (cancelled) return;
        setMountState({ tag: 'mounted', message: null });
      } catch (err) {
        if (cancelled) return;
        setMountState({
          tag: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [devSeed.ready, devSeed.seeded, handle.status, handle.handle]);

  // Close-directory wraps the handle close so we can unmount atomically
  // without a reactive effect chain.
  const closeDirectory = useCallback(async () => {
    if (isVaultMounted()) {
      await unmountVault();
    }
    await handle.closeDirectory();
    setMountState({ tag: 'idle', message: null });
  }, [handle]);

  const status: VaultMountStatus = useMemo(() => {
    if (!devSeed.ready || handle.restoring) return 'initializing';
    if (devSeed.seeded) return mountState.tag === 'mounted' ? 'mounted' : 'initializing';
    if (handle.status === 'empty') return 'empty';
    if (handle.status === 'prompt') return 'prompt';
    if (mountState.tag === 'error') return 'error';
    if (mountState.tag === 'mounted') return 'mounted';
    return 'mounting';
  }, [devSeed.ready, devSeed.seeded, handle.status, handle.restoring, mountState.tag]);

  const name = useMemo(() => {
    if (devSeed.seeded) return devSeed.seeded.name;
    if (handle.handle) return handle.handle.name;
    return null;
  }, [devSeed.seeded, handle.handle]);

  return {
    status,
    name,
    errorMessage: mountState.message,
    openDirectory: handle.openDirectory,
    restoreAccess: handle.restoreAccess,
    closeDirectory,
  };
}
