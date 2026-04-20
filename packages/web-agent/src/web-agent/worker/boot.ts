/**
 * Main-thread boot for the agent Worker.
 *
 * Spawns the Worker once per page (module-singleton-guarded for React
 * StrictMode and Vite fast refresh) and returns the agent RPC client +
 * the VFS MessagePort. Callers must mount the ZenFS Port backend on the
 * VFS port themselves (see `VaultProvider.tsx`).
 *
 * jsdom (vitest) does not implement Worker. When `Worker` is absent we
 * fall back to an in-process pair against a local AgentSession + WorkerHost
 * — the API surface is identical, just no real thread separation. This
 * lets the existing `App.test.tsx` smoke-render without crashing.
 */

import { AgentSession } from '../core/agent-session';
import { MemorySessionStore } from '../core/session/memory-store';
import { RpcClient } from '../rpc/rpc-client';
import { RpcServer } from '../rpc/rpc-server';
import { createInProcessTransportPair } from '../rpc/transports/in-process';
import { createWorkerTransportPair } from '../rpc/transports/worker';
import type { Transport } from '../rpc/transport';
import type { InMemoryVaultSeed } from './init-protocol';
import { WorkerAgentHost } from './worker-host';

export interface AgentWorkerBoot {
  /** RPC client talking to the Worker (or in-process fallback). */
  rpcClient: RpcClient;
  /**
   * Main-thread end of the VFS MessagePort. Mount ZenFS Port backend on it.
   * `null` when running under the in-process fallback (no Worker available).
   */
  vfsPort: MessagePort | null;
  /** Underlying Worker (null when running in fallback mode). */
  worker: Worker | null;
}

let booted: AgentWorkerBoot | null = null;

export function getAgentWorker(devSeed?: InMemoryVaultSeed): AgentWorkerBoot {
  if (booted) return booted;
  booted = bootOnce(devSeed);
  return booted;
}

/** Test-only escape hatch — drop the cached singleton so a fresh boot runs next call. */
export function _resetAgentWorkerForTests(): void {
  booted = null;
}

function bootOnce(devSeed?: InMemoryVaultSeed): AgentWorkerBoot {
  if (typeof Worker === 'undefined') {
    return bootInProcess();
  }
  try {
    const worker = new Worker(new URL('./agent-worker.ts', import.meta.url), {
      type: 'module',
      name: 'web-agent',
    });
    worker.addEventListener('error', e => {
      console.error('[web-agent] Worker error:', e.message, 'at', e.filename, ':', e.lineno);
    });
    worker.addEventListener('messageerror', e => {
      console.error('[web-agent] Worker messageerror:', e);
    });
    const { client, vfsPort } = createWorkerTransportPair(worker, { devSeed });
    return {
      rpcClient: new RpcClient(client),
      vfsPort,
      worker,
    };
  } catch (err) {
    // Some test runners stub `Worker` enough that `typeof Worker !== 'undefined'`
    // is true but construction throws (jsdom + module workers historically).
    // Fall back to in-process so the caller still has a functional client.
    console.warn('[web-agent] Worker construction failed; falling back to in-process:', err);
    return bootInProcess();
  }
}

function bootInProcess(): AgentWorkerBoot {
  const session = new AgentSession({});
  // No vfs port in fallback; vault tools won't work, but the agent does.
  const fakePort = makeFakePort();
  // In-process fallback uses MemorySessionStore so jsdom tests don't need IDB.
  const host = new WorkerAgentHost(session, fakePort, new MemorySessionStore());
  const { client: clientT, server: serverT } = createInProcessTransportPair();
  // Server retains itself via the transport's listener closure.
  new RpcServer(serverT, host);
  return {
    rpcClient: new RpcClient(clientT),
    vfsPort: null,
    worker: null,
  };
}

/** Stand-in for a MessagePort in environments where Worker isn't available. */
function makeFakePort(): MessagePort {
  const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
  if (channel) return channel.port1;
  // Last-ditch shim — listeners and posts no-op.
  const noop = () => {};
  return {
    postMessage: noop,
    addEventListener: noop,
    removeEventListener: noop,
    start: noop,
    close: noop,
    dispatchEvent: () => false,
    onmessage: null,
    onmessageerror: null,
  } as unknown as MessagePort;
}

/** Force-disposes the singleton boot (e.g. on page unload). */
export function disposeAgentWorker(): void {
  if (!booted) return;
  booted.rpcClient.dispose();
  if (booted.worker) booted.worker.terminate();
  booted = null;
}

export type { Transport };
