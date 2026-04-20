import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useDevSeedBoot } from '@/hooks/useDevSeedBoot';
import { useDirectoryHandle } from '@/hooks/useDirectoryHandle';
import { isVaultMounted, mountVaultPort, unmountVault } from '@/web-agent';
import { VaultContext } from '@/providers/vault-context';
import type { VaultContextValue, VaultMountStatus } from '@/providers/vault-context';
import { useWebAgent } from '@/providers/web-agent-context';

type MountStateTag = 'idle' | 'mounting' | 'mounted' | 'error';

export function VaultProvider({ children }: { children: ReactNode }) {
  const { rpcClient, vfsPort } = useWebAgent();
  const handle = useDirectoryHandle();

  const [mountState, setMountState] = useState<{
    tag: MountStateTag;
    message: string | null;
  }>({ tag: 'idle', message: null });

  // Tracks the handle (or seed) we've already kicked off a mount for so we
  // don't double-trigger when state transitions cause the effect to re-run.
  const mountInFlightForRef = useRef<unknown>(null);
  const portMountedRef = useRef(false);
  const devSeed = useDevSeedBoot(mountState.tag === 'mounted');

  // Trigger Worker-side mount as soon as a handle (or seed) is available.
  // The promise lives outside the effect's lifecycle so subsequent state
  // transitions don't cancel it.
  useEffect(() => {
    const seedPresent =
      import.meta.env.DEV &&
      typeof window !== 'undefined' &&
      !!(window as unknown as { __zenfsSeed?: unknown }).__zenfsSeed;

    // Dev-seed: Worker mounted InMemory at init; just announce mounted once.
    if (seedPresent) {
      if (mountInFlightForRef.current === 'seed') return;
      mountInFlightForRef.current = 'seed';
      (async () => {
        await Promise.resolve();
        setMountState({ tag: 'mounted', message: null });
      })();
      return;
    }

    if (handle.status !== 'ready' || !handle.handle) return;
    if (mountInFlightForRef.current === handle.handle) return;
    mountInFlightForRef.current = handle.handle;

    (async () => {
      await Promise.resolve();
      setMountState({ tag: 'mounting', message: null });
    })();

    rpcClient
      .mountVault(handle.handle)
      .then(() => {
        setMountState({ tag: 'mounted', message: null });
      })
      .catch(err => {
        mountInFlightForRef.current = null; // allow retry
        setMountState({
          tag: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [handle.status, handle.handle, rpcClient]);

  // Mount the Port backend on main once the Worker confirms a real fs is
  // attached on the other side. mountVaultPort itself is idempotent.
  useEffect(() => {
    if (!vfsPort) return;
    if (mountState.tag !== 'mounted') return;
    if (portMountedRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        await mountVaultPort(vfsPort);
        if (cancelled) return;
        portMountedRef.current = true;
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
  }, [vfsPort, mountState.tag]);

  const closeDirectory = useCallback(async () => {
    try {
      await rpcClient.unmountVault();
    } catch {
      // best-effort
    }
    if (isVaultMounted()) {
      await unmountVault();
    }
    portMountedRef.current = false;
    mountInFlightForRef.current = null;
    await handle.closeDirectory();
    setMountState({ tag: 'idle', message: null });
  }, [handle, rpcClient]);

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
