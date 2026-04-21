import type { Transport } from '../transport';

function wrapPort(port: MessagePort): Transport {
  port.start();
  return {
    send(message) {
      port.postMessage(message);
    },
    onMessage(handler) {
      const listener = (e: MessageEvent) => handler(e.data);
      port.addEventListener('message', listener);
      return () => port.removeEventListener('message', listener);
    },
    close() {
      port.close();
    },
  };
}

/**
 * Create a pair of Transports backed by a single MessageChannel.
 *
 * Both ends run in the same JS context (main thread in Phase 1). Phase 4
 * swaps this for a Worker MessagePort pair without touching the client or
 * server implementations — the Transport shape is identical.
 */
export function createInProcessTransportPair(): { client: Transport; server: Transport } {
  const channel = new MessageChannel();
  return {
    client: wrapPort(channel.port1),
    server: wrapPort(channel.port2),
  };
}
