/**
 * Worker-backed Transport pair.
 *
 * Companion to `in-process.ts`. Same `Transport` shape; the dispatcher and
 * RPC server/client never need to know which transport is in use.
 *
 * Spawns two MessageChannels (one for agent RPC, one for ZenFS) and
 * transfers both worker-side ports to the Worker via a single init message.
 * The init protocol is intentionally tagged so the Worker can distinguish
 * the init payload from per-channel traffic.
 */

import {
  AGENT_WORKER_INIT_TYPE,
  type AgentWorkerInit,
  type InMemoryVaultSeed,
  type WebAgentOptions,
} from '../../worker/init-protocol';
import type { Transport } from '../transport';

export interface WorkerTransportPair {
  /** Agent RPC transport: wraps the main-thread end of ChannelA. */
  client: Transport;
  /** Main-thread end of ChannelB; mount the ZenFS Port backend on this. */
  vfsPort: MessagePort;
}

export interface CreateWorkerTransportPairOptions {
  /**
   * Dev-only seed forwarded to the Worker init message. When present, the
   * Worker mounts an InMemory ZenFS backend immediately and seeds the files
   * — matching the existing `useDevSeedBoot` semantics for Playwright.
   */
  devSeed?: InMemoryVaultSeed;
  /** Library-level options forwarded to the Worker. */
  agentOptions?: WebAgentOptions;
}

export function createWorkerTransportPair(
  worker: Worker,
  options: CreateWorkerTransportPairOptions = {}
): WorkerTransportPair {
  const channelA = new MessageChannel();
  const channelB = new MessageChannel();

  const init: AgentWorkerInit = {
    type: AGENT_WORKER_INIT_TYPE,
    agentPort: channelA.port2,
    vfsPort: channelB.port2,
    devSeed: options.devSeed,
    options: options.agentOptions,
  };
  worker.postMessage(init, [channelA.port2, channelB.port2]);

  return {
    client: wrapPort(channelA.port1),
    vfsPort: channelB.port1,
  };
}

function wrapPort(port: MessagePort): Transport {
  port.start();
  return {
    send(message) {
      port.postMessage(message);
    },
    onMessage(handler) {
      const listener = (e: MessageEvent) => handler(e.data);
      port.addEventListener('message', listener);
      return () => port.removeEventListener('message', listener);
    },
    close() {
      port.close();
    },
  };
}
