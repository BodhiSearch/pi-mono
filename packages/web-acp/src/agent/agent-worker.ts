/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AcpAgentAdapter } from '@/acp/agent-adapter';
import { BodhiProvider } from './bodhi-provider';
import { createInlineAgent } from './inline-agent';
import { createSessionStore } from './session-store';
import { createStreamFn } from './stream-fn';
import { createMessagePortStream } from '@/transport/worker-stream';
import { attachVolumeChannel } from './volume-channel';
import { VolumeRegistry, type VolumeInit } from './volume-mount';

export interface AgentWorkerInitMessage {
  type: 'init';
  agentPort: MessagePort;
  volumes?: VolumeInit[];
}

type IncomingMessage = AgentWorkerInitMessage;

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

async function startAgent(port: MessagePort, volumes: VolumeInit[]): Promise<void> {
  const { readable, writable } = createMessagePortStream(port);
  const stream = ndJsonStream(writable, readable);
  const provider = new BodhiProvider();
  const inline = createInlineAgent(createStreamFn(provider));
  const store = createSessionStore();
  const registry = new VolumeRegistry();
  attachVolumeChannel(scope, registry);
  // Mount any seeded volumes before the ACP connection starts taking
  // prompts so the first `prompt` turn already sees the right
  // `/mnt/<name>` entries.
  await registry.mountAll(volumes);
  const _connection = new AgentSideConnection(
    conn => new AcpAgentAdapter(conn, inline, provider, store, registry),
    stream
  );
  void _connection;
}
