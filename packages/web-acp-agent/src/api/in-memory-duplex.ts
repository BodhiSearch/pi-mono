import type { InMemoryDuplex } from './types';

export function createInMemoryDuplex(): InMemoryDuplex {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    agent: { readable: clientToAgent.readable, writable: agentToClient.writable },
    client: { readable: agentToClient.readable, writable: clientToAgent.writable },
  };
}
