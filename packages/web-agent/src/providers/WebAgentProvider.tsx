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
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { readDevSeed } from '@/fs/in-memory-vault';
import { disposeAgentWorker, getAgentWorker } from '@/web-agent';
import { WebAgentContext } from '@/providers/web-agent-context';
import type { WebAgentContextValue } from '@/providers/web-agent-context';

export function WebAgentProvider({ children }: { children: ReactNode }) {
  // Read seed + boot synchronously inside the lazy initializer so
  // StrictMode's double-render doesn't double-spawn the Worker (boot is
  // module-singleton-guarded but we avoid the redundant call too).
  const [boot] = useState(() => getAgentWorker({ devSeed: readDevSeed() }));

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handler = () => disposeAgentWorker();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const value = useMemo<WebAgentContextValue>(
    () => ({
      rpcClient: boot.rpcClient,
      vfsPort: boot.vfsPort,
      hasWorker: boot.worker !== null,
    }),
    [boot]
  );

  return <WebAgentContext.Provider value={value}>{children}</WebAgentContext.Provider>;
}
