import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { isVaultMounted, mountVault, unmountVault } from '@/web-agent/fs/zenfs-provider';
import { useDevSeedBoot } from '@/hooks/useDevSeedBoot';
import { useDirectoryHandle } from '@/hooks/useDirectoryHandle';
import { VaultContext } from '@/providers/vault-context';
import type { VaultContextValue, VaultMountStatus } from '@/providers/vault-context';

type MountStateTag = 'idle' | 'mounting' | 'mounted' | 'error';

export function VaultProvider({ children }: { children: ReactNode }) {
  const devSeed = useDevSeedBoot();
  const handle = useDirectoryHandle();

  const [mountState, setMountState] = useState<{
    tag: MountStateTag;
    message: string | null;
  }>({ tag: 'idle', message: null });

  useEffect(() => {
    if (!devSeed.ready) return;

    let cancelled = false;

    (async () => {
      if (devSeed.seeded) {
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

  const value = useMemo<VaultContextValue>(
    () => ({
      status,
      name,
      errorMessage: mountState.message,
      openDirectory: handle.openDirectory,
      restoreAccess: handle.restoreAccess,
      closeDirectory,
    }),
    [status, name, mountState.message, handle.openDirectory, handle.restoreAccess, closeDirectory]
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}
