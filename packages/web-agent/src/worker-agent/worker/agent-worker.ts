/**
 * Web Worker entry — owns the agent runtime, its tool execution, and the
 * real ZenFS mount. Session persistence is Dexie-backed (IndexedDB);
 * see `core/session/store.ts` + `core/session/dexie-store.ts`.
 *
 * Boot sequence:
 *   1. Wait for the init message on the global self port.
 *   2. Construct an AgentSession + SessionStore + WorkerAgentHost.
 *   3. Bind the agent RPC server to the agent port.
 *   4. If a dev seed was provided, mount the InMemory ZenFS backend
 *      immediately. Otherwise, the host waits for `mount_vault(handle)`
 *      from the main thread.
 *   5. Best-effort delete the legacy ZenFS-backed IDB DB (`web-agent-sessions`).
 */

import { streamSimple } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import { AgentSession } from '../core/agent-session';
import { DexieSessionStore, WebAgentDB } from '../core/session/dexie-store';
import { RpcServer } from '../rpc/rpc-server';
import { isAgentWorkerInit, type InMemoryVaultSeed, type WebAgentOptions } from './init-protocol';
import { WorkerAgentHost } from './worker-host';

const LEGACY_SESSIONS_DB = 'web-agent-sessions';

/**
 * Placeholder API key. The OpenAI-family providers in `pi-ai` treat a
 * missing `apiKey` as a precondition failure before the HTTP request is
 * built, even though our real authentication is a Bearer token patched
 * into the request headers by `makeStreamFn` below. Any non-empty string
 * satisfies the precondition; the server never sees this value.
 */
const API_KEY_PRESENCE_PLACEHOLDER = 'web-agent-auth-via-bearer-header';

self.addEventListener('message', event => {
  const data = event.data;
  if (!isAgentWorkerInit(data)) return;
  boot(data.agentPort, data.vfsPort, data.devSeed, data.options).catch(err => {
    console.error('[agent-worker] boot failed:', err);
  });
});

async function boot(
  agentPort: MessagePort,
  vfsPort: MessagePort,
  devSeed: InMemoryVaultSeed | undefined,
  options: WebAgentOptions | undefined
): Promise<void> {
  const session = new AgentSession({
    getApiKey: () => API_KEY_PRESENCE_PLACEHOLDER,
  });
  // Build the streamFn here — closes over session.getAuthToken() so token
  // rotation pushed via set_auth_token takes effect on the next request.
  session.setStreamFn(makeStreamFn(session));

  // Both ports were transferred via postMessage; addEventListener-based
  // listeners require an explicit start() before delivery begins.
  vfsPort.start();

  const store = new DexieSessionStore(
    options?.sessionsDbName ? new WebAgentDB(options.sessionsDbName) : new WebAgentDB()
  );
  const host = new WorkerAgentHost(session, vfsPort, store, {
    vaultMount: options?.vaultMount,
  });

  agentPort.start();
  const transport = {
    send(message: unknown) {
      agentPort.postMessage(message);
    },
    onMessage(handler: (message: unknown) => void): () => void {
      const listener = (e: MessageEvent) => handler(e.data);
      agentPort.addEventListener('message', listener);
      return () => agentPort.removeEventListener('message', listener);
    },
    close() {
      agentPort.close();
    },
  };

  // Server retains itself via the transport's listener closure.
  new RpcServer(transport, host);

  if (devSeed) {
    try {
      await host.mountDevSeed(devSeed);
    } catch (err) {
      console.error('[agent-worker] dev seed mount failed:', err);
    }
  }

  // Best-effort cleanup of the legacy M5 IDB DB (ZenFS-backed sessions).
  // No-op if it never existed. Guarded with a try so a concurrent tab
  // holding the DB open doesn't crash boot.
  try {
    indexedDB.deleteDatabase(LEGACY_SESSIONS_DB);
  } catch {
    // best-effort
  }
}

function makeStreamFn(session: AgentSession): StreamFn {
  return (model, context, options) => {
    const token = session.getAuthToken();
    const headers = token
      ? { ...model.headers, Authorization: `Bearer ${token}`, 'x-api-key': token }
      : model.headers;
    const patched = headers !== model.headers ? { ...model, headers } : model;
    return streamSimple(patched, context, options);
  };
}
