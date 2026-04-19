import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type {
  RpcCommand,
  RpcCommandType,
  RpcEventEnvelope,
  RpcResponse,
  RpcSessionState,
} from './rpc-types';
import type { Transport } from './transport';

/**
 * Narrow interface of the session surface the RPC server drives.
 *
 * `AgentSession` satisfies this structurally. Isolating the shape as an
 * interface keeps the server independent of its default implementation,
 * which lets tests drive the server with a fake session without dragging
 * in `pi-agent-core`'s full Agent machinery.
 */
export interface AgentSessionHost {
  prompt(message: string): Promise<void>;
  abort(): void;
  setModel(model: Model<Api> | undefined): void;
  setSystemPrompt(prompt: string): void;
  reset(): void;
  getState(): RpcSessionState;
  getMessages(): AgentMessage[];
  isStreaming(): boolean;
  getStreamingMessage(): AgentMessage | undefined;
  getErrorMessage(): string | undefined;
  subscribe(handler: (event: AgentEvent) => void | Promise<void>): () => void;
}

/**
 * Binds a `Transport` to an `AgentSession`.
 *
 * Incoming RpcCommand messages are dispatched to session methods; the
 * correlated RpcResponse is sent back on the same transport. AgentEvents
 * emitted by the session are wrapped in an RpcEventEnvelope (with a
 * state snapshot) and pushed to the transport unsolicited.
 */
export class RpcServer {
  private readonly unsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(transport: Transport, session: AgentSessionHost) {
    this.unsubscribers.push(
      transport.onMessage(raw => {
        void this.handleCommand(transport, session, raw);
      })
    );

    this.unsubscribers.push(
      session.subscribe(event => {
        if (this.disposed) return;
        const envelope: RpcEventEnvelope = {
          type: 'event',
          event,
          messages: session.getMessages(),
          isStreaming: session.isStreaming(),
          streamingMessage: session.getStreamingMessage(),
          errorMessage: session.getErrorMessage(),
        };
        transport.send(envelope);
      })
    );
  }

  private async handleCommand(
    transport: Transport,
    session: AgentSessionHost,
    raw: unknown
  ): Promise<void> {
    if (!isRpcCommand(raw)) return;
    const { id, type } = raw;
    try {
      switch (type) {
        case 'prompt':
          await session.prompt(raw.message);
          transport.send(ok(id, 'prompt'));
          return;
        case 'abort':
          session.abort();
          transport.send(ok(id, 'abort'));
          return;
        case 'get_state':
          transport.send({
            id,
            type: 'response',
            command: 'get_state',
            success: true,
            data: session.getState(),
          } satisfies RpcResponse);
          return;
        case 'get_messages':
          transport.send({
            id,
            type: 'response',
            command: 'get_messages',
            success: true,
            data: session.getMessages(),
          } satisfies RpcResponse);
          return;
        case 'set_model':
          session.setModel(raw.model);
          transport.send(ok(id, 'set_model'));
          return;
        case 'set_system_prompt':
          session.setSystemPrompt(raw.prompt);
          transport.send(ok(id, 'set_system_prompt'));
          return;
        case 'reset':
          session.reset();
          transport.send(ok(id, 'reset'));
          return;
      }
    } catch (err) {
      transport.send({
        id,
        type: 'response',
        command: type,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies RpcResponse);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}

function ok<C extends 'prompt' | 'abort' | 'set_model' | 'set_system_prompt' | 'reset'>(
  id: string,
  command: C
): RpcResponse {
  return { id, type: 'response', command, success: true } as RpcResponse;
}

function isRpcCommand(value: unknown): value is RpcCommand {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.type === 'string' && isKnownCommandType(v.type);
}

const KNOWN_COMMANDS: Record<RpcCommandType, true> = {
  prompt: true,
  abort: true,
  get_state: true,
  get_messages: true,
  set_model: true,
  set_system_prompt: true,
  reset: true,
};

function isKnownCommandType(value: string): value is RpcCommandType {
  return Object.hasOwn(KNOWN_COMMANDS, value);
}
