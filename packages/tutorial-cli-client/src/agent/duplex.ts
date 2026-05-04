export interface ByteTransport {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}

export interface DuplexPair {
	agent: ByteTransport;
	client: ByteTransport;
}

export function createInMemoryDuplex(): DuplexPair {
	const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
	const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
	return {
		agent: { readable: clientToAgent.readable, writable: agentToClient.writable },
		client: { readable: agentToClient.readable, writable: clientToAgent.writable },
	};
}
