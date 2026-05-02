/**
 * In-process ACP embed: stand up the agent and the client both inside
 * the same Node process, joined by an in-memory duplex byte-stream
 * pair. The client side returns an `AcpClient` so the shell layer can
 * issue requests; the agent side is fully owned by
 * `@bodhiapp/web-acp-agent`'s `AcpAgentAdapter`.
 *
 * The agent and client speak the exact same NDJSON-framed JSON-RPC
 * wire as the browser worker does — this is the proof point that
 * `web-acp-agent` is genuinely transport- and runtime-neutral.
 */

import {
  ClientSideConnection,
  ndJsonStream,
  requestPermissionStub,
  startAcpAgent,
  type AcpAgentAdapter,
  type VolumeRegistry,
} from '@bodhiapp/web-acp-agent';
import type { Client, SessionNotification } from '@agentclientprotocol/sdk';
import { AcpClient } from './client';
import { createInMemoryDuplex } from './duplex';
import { assembleNodeServices, type AssembleNodeServicesOptions } from '../services/assemble';
import type { BodhiProvider } from '@bodhiapp/web-acp-agent';
import type { AppDb, KvStore } from '../storage';

export interface EmbeddedHostOptions extends AssembleNodeServicesOptions {
  /** Build version reported on `/version`. */
  buildVersion?: string;
  /** Version of `@agentclientprotocol/sdk` reported on `/version`. */
  acpSdkVersion?: string;
  /** True to enable DEV-only features (forceToolCall etc.). */
  isDev?: boolean;
}

export interface EmbeddedHost {
  client: AcpClient;
  provider: BodhiProvider;
  /** Agent adapter — exposed for `dispose()` on teardown. */
  adapter: AcpAgentAdapter;
  /** Sqlite database. Shared with the agent's stores. */
  db: AppDb;
  /** Host-only KV façade for requestedMcps / lastModelId / volumes. */
  kv: KvStore;
  /**
   * The agent's volume registry. Exposed so `/volume add/remove`
   * commands can mount/unmount at runtime without recreating the
   * agent. Note: the agent's tool catalog is recomputed at the
   * start of each turn, so newly mounted volumes are picked up by
   * the next prompt — no explicit invalidation call is required.
   */
  volumes: VolumeRegistry;
  /** Tear down both ends of the embedded transport. */
  dispose(): Promise<void>;
}

const DEFAULT_BUILD_VERSION = '0.0.0';
const DEFAULT_ACP_SDK_VERSION = '0.17.0';

export async function createEmbeddedHost(opts: EmbeddedHostOptions): Promise<EmbeddedHost> {
  const { services, provider, db, kv } = await assembleNodeServices(opts);
  const duplex = createInMemoryDuplex();

  let adapter: AcpAgentAdapter | undefined;
  startAcpAgent(duplex.agent, services, {
    isDev: opts.isDev ?? false,
    buildVersion: opts.buildVersion ?? DEFAULT_BUILD_VERSION,
    acpSdkVersion: opts.acpSdkVersion ?? DEFAULT_ACP_SDK_VERSION,
    onAdapter: a => {
      adapter = a;
    },
  });

  const clientStream = ndJsonStream(duplex.client.writable, duplex.client.readable);
  // Holder pattern (mirrors `packages/web-acp/src/acp/runtime.ts`):
  // `ClientSideConnection`'s constructor invokes `toClient` synchronously,
  // before our `AcpClient` instance exists. The handler closures resolve
  // the client lazily via `holder.client` so notifications arriving after
  // construction route through the assembled `AcpClient`.
  const holder: { client?: AcpClient } = {};
  const handler: Client = {
    requestPermission: requestPermissionStub,
    async sessionUpdate(params: SessionNotification) {
      holder.client?.dispatchSessionUpdate(params);
    },
  };
  const conn = new ClientSideConnection(() => handler, clientStream);
  const client = new AcpClient(conn);
  holder.client = client;

  if (!adapter) {
    // `startAcpAgent` synchronously invokes `toAgent(conn)` which calls
    // `onAdapter` before returning. The guard here is a paranoia check
    // for SDK refactors; if it ever fails we want a clear error.
    throw new Error('startAcpAgent did not invoke onAdapter');
  }

  await client.initialize();

  if (!services.registry) {
    throw new Error('embedded-host: services.registry is required');
  }

  return {
    client,
    provider,
    adapter,
    db,
    kv,
    volumes: services.registry,
    async dispose(): Promise<void> {
      try {
        await adapter?.dispose();
      } catch (err) {
        console.error('[embedded-host] adapter.dispose() failed:', err);
      }
      // Close the client conn last so the agent has a chance to flush
      // pending updates first.
      try {
        await closeStream(duplex.client.writable);
        await closeStream(duplex.agent.writable);
      } catch {
        // ignore: streams may already be closed
      }
      try {
        db.$sqlite.close();
      } catch {
        // ignore: db may already be closed
      }
    },
  };
}

async function closeStream(stream: WritableStream<unknown>): Promise<void> {
  try {
    const writer = stream.getWriter();
    await writer.close();
    writer.releaseLock();
  } catch {
    // ignore
  }
}
