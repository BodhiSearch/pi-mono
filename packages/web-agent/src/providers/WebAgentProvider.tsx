/**
 * Owns the Worker lifecycle for the rest of the app.
 *
 * Spawned exactly once per page (module-singleton in `worker/boot.ts`).
 * Exposes the RpcClient + the VFS MessagePort via context so:
 *   - useAgent talks to the agent over RpcClient
 *   - VaultProvider mounts the ZenFS Port backend on the VFS port
 *
 * The dev seed (when present) is read synchronously and forwarded to the
 * Worker on first boot, before any UI consumer can call into fs.
 *
 * The persisted extension enabled map is hydrated from IDB before the
 * first boot so the Worker's initial vault scan honours the user's
 * previous choices without a round-trip churn.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { readDevSeed } from '@/fs/in-memory-vault';
import { ExtensionStore } from '@/extension-store/ExtensionStore';
import { disposeAgentWorker, getAgentWorker } from '@/worker-agent';
import type { AgentWorkerBoot } from '@/worker-agent';
import { WebAgentContext } from '@/providers/web-agent-context';
import type { WebAgentContextValue } from '@/providers/web-agent-context';

export function WebAgentProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<AgentWorkerBoot | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Hydrate the persisted enabled map from IDB before booting so
      // the Worker's first `mountDevSeed` / `mountVault` load already
      // skips extensions the user disabled previously.
      let initialExtensionEnabledState: Record<string, boolean> = {};
      try {
        initialExtensionEnabledState = await new ExtensionStore().load();
      } catch (err) {
        console.error('[WebAgentProvider] ExtensionStore.load failed:', err);
      }
      if (cancelled) return;
      setBoot(
        getAgentWorker({
          devSeed: readDevSeed(),
          agentOptions: { initialExtensionEnabledState },
        })
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handler = () => disposeAgentWorker();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const value = useMemo<WebAgentContextValue | null>(
    () =>
      boot
        ? {
            rpcClient: boot.rpcClient,
            vfsPort: boot.vfsPort,
            hasWorker: boot.worker !== null,
          }
        : null,
    [boot]
  );

  if (!value) return null;
  return <WebAgentContext.Provider value={value}>{children}</WebAgentContext.Provider>;
}
