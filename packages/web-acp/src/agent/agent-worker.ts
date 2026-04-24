/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AcpAgentAdapter } from '@/acp/agent-adapter';
import { BodhiProvider } from './bodhi-provider';
import { createInlineAgent } from './inline-agent';
import { McpConnectionPool } from './mcp';
import { createStoreFromDb, openSessionDb } from './session-store';
import { createStreamFn, type StreamOptionOverrides } from './stream-fn';
import { createMessagePortStream } from '@/transport/worker-stream';
import { attachVolumeChannel } from './volume-channel';
import { VolumeRegistry, type VolumeInit } from './volume-mount';
import { createFeatureStore } from '@/features/feature-store';

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
  // Per-turn override holder threaded between the adapter and the
  // stream function. The adapter pushes `toolChoice` into this bag
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
  const store = createStoreFromDb(db);
  const features = createFeatureStore(db);
  const registry = new VolumeRegistry();
  attachVolumeChannel(scope, registry);
  // Mount any seeded volumes before the ACP connection starts taking
  // prompts so the first `prompt` turn already sees the right
  // `/mnt/<name>` entries.
  await registry.mountAll(volumes);
  const mcpPool = new McpConnectionPool();
  const _connection = new AgentSideConnection(
    conn =>
      new AcpAgentAdapter(
        conn,
        inline,
        provider,
        store,
        registry,
        features,
        streamOverrides,
        mcpPool
      ),
    stream
  );
  void _connection;
}
