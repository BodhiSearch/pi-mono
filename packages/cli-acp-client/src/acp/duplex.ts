/**
 * In-process byte-stream duplex pair used by the embedded host: one side
 * gives to the ACP agent (`startAcpAgent`), the other side gives to the
 * ACP client (`ClientSideConnection`). Together they let both ends speak
 * NDJSON-framed JSON-RPC over the WHATWG stream contract that
 * `@bodhiapp/web-acp-agent`'s `AcpTransport` accepts.
 *
 * No MessageChannel / Worker / socket — just two `TransformStream`s.
 */

export interface ByteTransport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface DuplexPair {
  /** Hand to `startAcpAgent(...)` on the agent side. */
  agent: ByteTransport;
  /** Hand to `ndJsonStream(client.writable, client.readable)` on the client side. */
  client: ByteTransport;
}

export function createInMemoryDuplex(): DuplexPair {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    agent: {
      readable: clientToAgent.readable,
      writable: agentToClient.writable,
    },
    client: {
      readable: agentToClient.readable,
      writable: clientToAgent.writable,
    },
  };
}
