import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Client, InitializeResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { AcpClient } from '@/acp/client';
import { buildFsHandlers } from '@/acp/fs-handlers';
import { requestPermissionStub } from '@/acp/permissions';
import type { HostVolumeInit } from '@/runtime/volumes-fsa';
import { createMessagePortStream } from '@/runtime/transport/worker-stream';
import { createVolumeControl, type VolumeControl } from '@/runtime/volumes-fsa';
import { MainZenfs } from '@/vault/main-zenfs';

// Module-scope singleton so we spawn exactly one agent worker per tab
// (StrictMode double-mount must not create a second worker).

export interface AcpRuntime {
  worker: Worker;
  client: AcpClient;
  volumeControl: VolumeControl;
  mainZenfs: MainZenfs;
  initialize: Promise<void>;
  resolveInit: (volumes: HostVolumeInit[]) => void;
}

let _runtime: AcpRuntime | null = null;
let _initResponse: InitializeResponse | null = null;
let _authKey: string | null = null;
let _authPromise: Promise<void> | null = null;
let _session: string | null = null;
let _sessionPromise: Promise<string> | null = null;
// Backs `useSyncExternalStore` for the active session id.
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
  const mainZenfs = new MainZenfs();
  const initPromise = new Promise<void>(resolve => {
    resolveInit = (volumes: HostVolumeInit[]) => {
      if (initPosted) return;
      initPosted = true;
      // Duplicate-mount on the main thread for the fs/* handler seam;
      // worker is authoritative so we don't block init on this.
      void mainZenfs.mountAll(volumes);
      worker.postMessage({ type: 'init', agentPort: channel.port2, volumes }, [channel.port2]);
      resolve();
    };
  });
  const { readable, writable } = createMessagePortStream(channel.port1);
  const stream = ndJsonStream(writable, readable);

  const holder: { client?: AcpClient } = {};
  const fsHandlers = buildFsHandlers({ view: { list: () => mainZenfs.list() } });
  const handler: Client = {
    requestPermission: requestPermissionStub,
    async sessionUpdate(params: SessionNotification) {
      holder.client?.dispatchSessionUpdate(params);
    },
    async extNotification(method: string, params: Record<string, unknown>) {
      holder.client?.dispatchExtNotification(method, params);
    },
    async readTextFile(params) {
      return fsHandlers.readTextFile(params);
    },
    async writeTextFile(params) {
      return fsHandlers.writeTextFile(params);
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
  const volumeControl = wrapVolumeControl(createVolumeControl(worker), mainZenfs);
  _runtime = { worker, client, volumeControl, mainZenfs, initialize, resolveInit };

  // Best-effort tab-close hook so the agent can release MCP refcounts and
  // abort in-flight work. `pagehide` covers close/nav/bfcache; `beforeunload`
  // is the legacy fallback. Fire-and-forget — the message may not round-trip.
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

/**
 * Mirror worker-side mount/unmount onto the main-thread ZenFS so the
 * `fs/*` handlers stay in sync with the volume registry. Worker-side
 * mount is authoritative — main-thread failures are logged but never
 * surfaced to the caller since the handler falls through to a
 * membership check anyway.
 */
function wrapVolumeControl(inner: VolumeControl, mainZenfs: MainZenfs): VolumeControl {
  return {
    async mount(init) {
      await inner.mount(init);
      try {
        await mainZenfs.mount(init);
      } catch (err) {
        console.warn('[acp/runtime] main-zenfs mount failed:', err);
      }
    },
    async unmount(mountName) {
      await inner.unmount(mountName);
      try {
        await mainZenfs.unmount(mountName);
      } catch (err) {
        console.warn('[acp/runtime] main-zenfs unmount failed:', err);
      }
    },
    dispose() {
      inner.dispose();
    },
  };
}

// Accessor surface for the per-tab session and auth state. Module-scope
// `let`s rather than a class so Hot Module Reload boundaries stay clean
// and StrictMode-driven double effects observe the same identity.

export function getSession(): string | null {
  return _session;
}

export function setSession(id: string | null): void {
  if (_session === id) return;
  _session = id;
  // Snapshot the set so a listener that unsubscribes itself doesn't disturb the loop.
  for (const listener of [..._sessionListeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[acp/runtime] session listener threw:', err);
    }
  }
}

/** Subscribe form for `useSyncExternalStore`; pair with {@link getSession}. */
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
