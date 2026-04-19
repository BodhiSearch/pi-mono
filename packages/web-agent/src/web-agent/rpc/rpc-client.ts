import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { RpcCommand, RpcEventEnvelope, RpcResponse, RpcSessionState } from './rpc-types';
import type { Transport } from './transport';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

// `Omit<Union, K>` collapses to the intersection of keys and drops
// per-member fields. Distributing over the union keeps each variant intact.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RpcCommandPayload = DistributiveOmit<RpcCommand, 'id'>;

/**
 * Typed client over a `Transport`.
 *
 * Each method issues a correlated RpcCommand and resolves when the matching
 * RpcResponse returns. Event envelopes are dispatched to `subscribe()`
 * listeners; they are not correlated with any pending promise.
 */
export class RpcClient {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(envelope: RpcEventEnvelope) => void>();
  private readonly transport: Transport;
  private readonly unsubscribe: () => void;
  private idCounter = 0;

  constructor(transport: Transport) {
    this.transport = transport;
    this.unsubscribe = transport.onMessage(raw => this.dispatch(raw));
  }

  prompt(message: string): Promise<void> {
    return this.send({ type: 'prompt', message }) as Promise<void>;
  }

  abort(): Promise<void> {
    return this.send({ type: 'abort' }) as Promise<void>;
  }

  getState(): Promise<RpcSessionState> {
    return this.send({ type: 'get_state' }) as Promise<RpcSessionState>;
  }

  getMessages(): Promise<AgentMessage[]> {
    return this.send({ type: 'get_messages' }) as Promise<AgentMessage[]>;
  }

  setModel(model: Model<Api> | undefined): Promise<void> {
    return this.send({ type: 'set_model', model }) as Promise<void>;
  }

  setSystemPrompt(prompt: string): Promise<void> {
    return this.send({ type: 'set_system_prompt', prompt }) as Promise<void>;
  }

  reset(): Promise<void> {
    return this.send({ type: 'reset' }) as Promise<void>;
  }

  subscribe(listener: (envelope: RpcEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribe();
    for (const p of this.pending.values()) {
      p.reject(new Error('RpcClient disposed'));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  private send(cmd: RpcCommandPayload): Promise<unknown> {
    const id = `rpc-${++this.idCounter}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ ...cmd, id } as RpcCommand);
    });
  }

  private dispatch(raw: unknown): void {
    if (!isEnvelope(raw)) return;
    if (raw.type === 'event') {
      for (const listener of this.listeners) listener(raw);
      return;
    }
    if (raw.type === 'response') {
      const pending = this.pending.get(raw.id);
      if (!pending) return;
      this.pending.delete(raw.id);
      if (raw.success) {
        pending.resolve('data' in raw ? raw.data : undefined);
      } else {
        pending.reject(new Error(raw.error));
      }
    }
  }
}

function isEnvelope(value: unknown): value is RpcResponse | RpcEventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'response' || t === 'event';
}
