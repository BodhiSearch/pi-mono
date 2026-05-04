import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Client, InitializeResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { AcpClient } from '@/acp/client';
import type { HostVolumeInit } from '@/runtime/volumes-fsa';
import { createMessagePortStream } from '@/runtime/transport/worker-stream';
import { createVolumeControl, type VolumeControl } from '@/runtime/volumes-fsa';

// Module-scope singleton so we spawn exactly one agent worker per tab
// (StrictMode double-mount must not create a second worker).

export interface AcpRuntime {
  worker: Worker;
  client: AcpClient;
  volumeControl: VolumeControl;
  initialize: Promise<void>;
  resolveInit: (volumes: HostVolumeInit[]) => void;
}

let _runtime: AcpRuntime | null = null;
let _initResponse: InitializeResponse | null = null;
let _authKey: string | null = null;
let _authPromise: Promise<void> | null = null;
let _session: string | null = null;
let _sessionPromise: Promise<string> | null = null;
const _sessionListeners = new Set<() => void>();
// Awaited by `sendMessage` so a model swap can't race the next prompt.
let _modelUpdatePromise: Promise<void> | null = null;

export function ensureRuntime(): AcpRuntime {
  if (_runtime) return _runtime;
  const worker = new Worker(new URL('../agent/agent-worker.ts', import.meta.url), {
    type: 'module',
  });
  const channel = new MessageChannel();
  // `init` is posted lazily after the initial volume list resolves so the
  // worker isn't asked to dispatch requests before the agent is constructed.
  let resolveInit!: (volumes: HostVolumeInit[]) => void;
  let initPosted = false;
  const initPromise = new Promise<void>(resolve => {
    resolveInit = (volumes: HostVolumeInit[]) => {
      if (initPosted) return;
      initPosted = true;
      worker.postMessage({ type: 'init', agentPort: channel.port2, volumes }, [channel.port2]);
      resolve();
    };
  });
  const { readable, writable } = createMessagePortStream(channel.port1);
  const stream = ndJsonStream(writable, readable);

  const holder: { client?: AcpClient } = {};
  const handler: Client = {
    // SDK requires `requestPermission` on the Client surface but our agent
    // never invokes it (no permission flow yet — see deferred.md).
    async requestPermission() {
      return { outcome: { outcome: 'cancelled' } };
    },
    async sessionUpdate(params: SessionNotification) {
      holder.client?.dispatchSessionUpdate(params);
    },
    async extNotification(method: string, params: Record<string, unknown>) {
      holder.client?.dispatchExtNotification(method, params);
    },
  };
  const conn = new ClientSideConnection(() => handler, stream);
  const client = new AcpClient(conn);
  holder.client = client;

  const initialize = initPromise
    .then(() => client.initialize())
    .then(resp => {
      _initResponse = resp;
    });
  const volumeControl = createVolumeControl(worker);
  _runtime = { worker, client, volumeControl, initialize, resolveInit };

  // Best-effort tab-close hook so the agent can release MCP refcounts and
  // abort in-flight work. `pagehide` covers close/nav/bfcache; `beforeunload`
  // is the legacy fallback. Fire-and-forget.
  if (typeof window !== 'undefined') {
    const onUnload = () => {
      const sessionId = _session;
      if (!sessionId) return;
      void client.closeSession(sessionId).catch(() => undefined);
    };
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
  }

  return _runtime;
}

// Accessor surface for the per-tab session and auth state. Module-scope
// `let`s rather than a class so HMR boundaries stay clean and StrictMode
// double effects observe the same identity.

export function getSession(): string | null {
  return _session;
}

export function setSession(id: string | null): void {
  if (_session === id) return;
  _session = id;
  for (const listener of [..._sessionListeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[acp/runtime] session listener threw:', err);
    }
  }
}

export function subscribeToSession(listener: () => void): () => void {
  _sessionListeners.add(listener);
  return () => {
    _sessionListeners.delete(listener);
  };
}

export function getSessionPromise(): Promise<string> | null {
  return _sessionPromise;
}

export function setSessionPromise(p: Promise<string> | null): void {
  _sessionPromise = p;
}

export function getAuthKey(): string | null {
  return _authKey;
}

export function setAuthKey(k: string | null): void {
  _authKey = k;
}

export function getAuthPromise(): Promise<void> | null {
  return _authPromise;
}

export function setAuthPromise(p: Promise<void> | null): void {
  _authPromise = p;
}

export function getModelUpdatePromise(): Promise<void> | null {
  return _modelUpdatePromise;
}

export function setModelUpdatePromise(p: Promise<void> | null): void {
  _modelUpdatePromise = p;
}

export function getInitResponse(): InitializeResponse | null {
  return _initResponse;
}
