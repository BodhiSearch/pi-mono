import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Client, SessionNotification } from '@agentclientprotocol/sdk';
import { AcpClient } from '@/acp/client';
import { buildFsHandlers } from '@/acp/fs-handlers';
import type { BodhiModelDescriptor } from '@/acp/index';
import { requestPermissionStub } from '@/acp/permissions';
import type { VolumeInit } from '@/agent/volume-mount';
import { createMessagePortStream } from '@/transport/worker-stream';
import { createVolumeControl, type VolumeControl } from '@/transport/volume-control';
import { MainZenfs } from '@/vault/main-zenfs';

// M8: when the package is lifted to `@bodhiapp/bodhi-web-acp`, this
// module-scope state moves to a context-bound runtime instance. Kept
// at module scope today so the singleton survives React StrictMode's
// double-mount of every effect — we spawn exactly one agent worker
// per tab, regardless of how many `useAcp()` consumers mount.

export interface AcpRuntime {
  worker: Worker;
  client: AcpClient;
  volumeControl: VolumeControl;
  mainZenfs: MainZenfs;
  initialize: Promise<void>;
  resolveInit: (volumes: VolumeInit[]) => void;
}

let _runtime: AcpRuntime | null = null;
let _authKey: string | null = null;
let _authPromise: Promise<void> | null = null;
let _authModels: BodhiModelDescriptor[] = [];
let _session: string | null = null;
let _sessionPromise: Promise<string> | null = null;

export function ensureRuntime(): AcpRuntime {
  if (_runtime) return _runtime;
  const worker = new Worker(new URL('../agent/agent-worker.ts', import.meta.url), {
    type: 'module',
  });
  const channel = new MessageChannel();
  // `init` is posted lazily once the main thread has resolved the
  // initial volume list (FSA handles + dev/test seeds). The
  // `ClientSideConnection` below would otherwise dispatch requests
  // into a worker that hasn't constructed the agent yet.
  let resolveInit!: (volumes: VolumeInit[]) => void;
  let initPosted = false;
  const mainZenfs = new MainZenfs();
  const initPromise = new Promise<void>(resolve => {
    resolveInit = (volumes: VolumeInit[]) => {
      if (initPosted) return;
      initPosted = true;
      // Mount duplicate backends on the main thread for the fs/*
      // client handler seam. We don't block ACP init on this — the
      // worker owns the source of truth and the handlers defensively
      // check membership on every call — but we do start mounting
      // immediately so handlers see the right entries by the time
      // an external ACP agent calls fs/readTextFile.
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

  const initialize = initPromise.then(() => client.initialize()).then(() => undefined);
  const volumeControl = wrapVolumeControl(createVolumeControl(worker), mainZenfs);
  _runtime = { worker, client, volumeControl, mainZenfs, initialize, resolveInit };
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

// --- Per-tab session/auth singletons ---------------------------------
// Accessor surface for the per-tab session and auth state. Module-scope
// `let`s rather than a class so Hot Module Reload boundaries stay clean
// and StrictMode-driven double effects observe the same identity.

export function getSession(): string | null {
  return _session;
}

export function setSession(id: string | null): void {
  _session = id;
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

export function getAuthModels(): BodhiModelDescriptor[] {
  return _authModels;
}

export function setAuthModels(m: BodhiModelDescriptor[]): void {
  _authModels = m;
}
