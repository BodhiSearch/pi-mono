/// <reference lib="webworker" />
import {
  assembleServices,
  BodhiProvider,
  createInlineAgent,
  createStreamFn,
  startAcpAgent,
  type StreamOptionOverrides,
  type VolumeInit,
  ZenfsVolumeRegistry,
} from '@bodhiapp/web-acp-agent';
import {
  createFeatureStore,
  createMcpToggleStore,
  createStoreFromDb,
  openSessionDb,
} from '@/runtime/storage-dexie';
import { createMessagePortStream } from '@/runtime/transport/worker-stream';
import { attachVolumeChannel, toAgentVolumeInit, type HostVolumeInit } from '@/runtime/volumes-fsa';

export interface AgentWorkerInitMessage {
  type: 'init';
  agentPort: MessagePort;
  volumes?: HostVolumeInit[];
}

type IncomingMessage = AgentWorkerInitMessage;

/**
 * Build-time constants injected by Vite's `define` (see `vite.config.ts`
 * + `vite-env.d.ts`). Read here and forwarded to the agent package via
 * `startAcpAgent` options — the agent package cannot see Vite's `define`
 * directly, so the host bridges them across the package boundary.
 */
const IS_DEV = typeof __WEB_ACP_DEV__ === 'boolean' ? __WEB_ACP_DEV__ : false;
const BUILD_VERSION = typeof __WEB_ACP_VERSION__ === 'string' ? __WEB_ACP_VERSION__ : 'unknown';
const ACP_SDK_VERSION = typeof __ACP_SDK_VERSION__ === 'string' ? __ACP_SDK_VERSION__ : 'unknown';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let initialized = false;

scope.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'init') return;
  if (initialized) {
    console.warn('[agent-worker] received duplicate init message; ignoring.');
    return;
  }
  initialized = true;
  void startAgent(msg.agentPort, msg.volumes ?? []);
});

async function startAgent(port: MessagePort, hostVolumes: HostVolumeInit[]): Promise<void> {
  const transport = createMessagePortStream(port);
  const provider = new BodhiProvider();
  // Per-turn override holder threaded between the engine and the
  // stream function. The engine pushes `toolChoice` into this bag
  // before each `prompt` turn (DEV-only forceToolCall feature). The
  // consume callback clears the bag after the first LLM call so the
  // pi-agent-core loop only forces a tool call on the initial request,
  // not on every iteration (which would cause an infinite tool-call
  // loop).
  const streamOverrides: { current: StreamOptionOverrides } = { current: {} };
  const inline = createInlineAgent(
    createStreamFn(provider, () => {
      const snapshot = streamOverrides.current;
      streamOverrides.current = {};
      return snapshot;
    })
  );
  const db = openSessionDb();
  const registry = new ZenfsVolumeRegistry();
  attachVolumeChannel(scope, registry);
  // Convert host-shaped volumes (FSA handle | seed) into the agent's
  // transport-agnostic VolumeInit (constructed FileSystem) before
  // the registry mounts them. This must happen before the ACP
  // connection starts so the first `prompt` turn already sees the
  // right `/mnt/<name>` entries.
  const initialVolumes: VolumeInit[] = await Promise.all(hostVolumes.map(toAgentVolumeInit));
  await registry.mountAll(initialVolumes);
  const services = assembleServices({
    inline,
    bodhi: provider,
    store: createStoreFromDb(db),
    registry,
    features: createFeatureStore(db),
    mcpToggles: createMcpToggleStore(db),
    streamOverrides,
  });
  startAcpAgent(transport, services, {
    isDev: IS_DEV,
    buildVersion: BUILD_VERSION,
    acpSdkVersion: ACP_SDK_VERSION,
  });
}
