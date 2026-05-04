/// <reference lib="webworker" />
import { BodhiProvider, startAgent, type VolumeInit } from '@bodhiapp/web-acp-agent';
import { createPreferenceStore, createStoreFromDb, openSessionDb } from '@/runtime/storage-dexie';
import { createMessagePortStream } from '@/runtime/transport/worker-stream';
import { attachVolumeChannel, toAgentVolumeInit, type HostVolumeInit } from '@/runtime/volumes-fsa';

export interface AgentWorkerInitMessage {
  type: 'init';
  agentPort: MessagePort;
  volumes?: HostVolumeInit[];
}

const BUILD_VERSION = typeof __WEB_ACP_VERSION__ === 'string' ? __WEB_ACP_VERSION__ : 'unknown';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let initialized = false;

scope.addEventListener('message', (event: MessageEvent<AgentWorkerInitMessage>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'init') return;
  if (initialized) {
    console.warn('[agent-worker] received duplicate init message; ignoring.');
    return;
  }
  initialized = true;
  void boot(msg.agentPort, msg.volumes ?? []);
});

async function boot(port: MessagePort, hostVolumes: HostVolumeInit[]): Promise<void> {
  const db = openSessionDb();
  const volumes: VolumeInit[] = await Promise.all(hostVolumes.map(toAgentVolumeInit));

  const handle = startAgent({
    transport: createMessagePortStream(port),
    provider: new BodhiProvider(),
    volumes,
    sessions: createStoreFromDb(db),
    preferences: createPreferenceStore(db),
    buildVersion: BUILD_VERSION,
  });

  // Bridge runtime mount/unmount postMessages from main thread to the
  // agent handle (FSA handles can't ride the ACP wire).
  attachVolumeChannel(scope, handle);
}
