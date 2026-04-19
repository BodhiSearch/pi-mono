/**
 * Transport is the serialization envelope between the RPC client and server.
 *
 * The messages crossing this boundary must be structured-cloneable so the
 * same interface can back an in-process MessageChannel (Phase 1) and a real
 * cross-thread Worker MessagePort (Phase 4) without changing either side.
 */
export interface Transport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): () => void;
  close?(): void;
}
