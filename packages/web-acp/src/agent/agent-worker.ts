/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { AcpAgentAdapter } from '@/acp/agent-adapter';
import { BodhiProvider } from './bodhi-provider';
import { createInlineAgent } from './inline-agent';
import { createStreamFn } from './stream-fn';
import { createMessagePortStream } from '@/transport/worker-stream';

export interface AgentWorkerInitMessage {
  type: 'init';
  agentPort: MessagePort;
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
  startAgent(msg.agentPort);
});

function startAgent(port: MessagePort): void {
  const { readable, writable } = createMessagePortStream(port);
  const stream = ndJsonStream(writable, readable);
  const provider = new BodhiProvider();
  const inline = createInlineAgent(createStreamFn(provider));
  const _connection = new AgentSideConnection(
    conn => new AcpAgentAdapter(conn, inline, provider),
    stream
  );
  void _connection;
}
