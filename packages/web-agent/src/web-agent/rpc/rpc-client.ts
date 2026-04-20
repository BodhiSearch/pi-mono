import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { SessionMeta, SessionSummary } from '../core/session/types';
import { deserializeError, serializeError } from './error';
import type {
  McpToolDescriptor,
  RpcAgentEventEnvelope,
  RpcCommand,
  RpcEventEnvelope,
  RpcResponse,
  RpcSessionLoadedEvent,
  RpcSessionState,
  RpcToolCallRequest,
} from './rpc-types';
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
 * Handler invoked when the server upcalls a tool that lives on this side of
 * the boundary (e.g. an MCP tool whose closure can't cross the Worker).
 * Returns the tool result; throws to surface a tool-call error back to the
 * Worker-side AgentSession.
 */
export type ToolCallHandler = (toolName: string, args: unknown) => Promise<unknown>;

/**
 * Typed client over a `Transport`.
 *
 * Each method issues a correlated RpcCommand and resolves when the matching
 * RpcResponse returns. Event envelopes are dispatched to `subscribe()`
 * listeners; they are not correlated with any pending promise.
 */
export class RpcClient {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(envelope: RpcAgentEventEnvelope) => void>();
  private readonly sessionLoadedListeners = new Set<(event: RpcSessionLoadedEvent) => void>();
  private readonly transport: Transport;
  private readonly unsubscribe: () => void;
  private idCounter = 0;
  private toolCallHandler: ToolCallHandler | null = null;

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

  setAuthToken(token: string | null): Promise<void> {
    return this.send({ type: 'set_auth_token', token }) as Promise<void>;
  }

  mountVault(handle: FileSystemDirectoryHandle): Promise<void> {
    return this.send({ type: 'mount_vault', handle }) as Promise<void>;
  }

  unmountVault(): Promise<void> {
    return this.send({ type: 'unmount_vault' }) as Promise<void>;
  }

  setMcpTools(tools: McpToolDescriptor[]): Promise<void> {
    return this.send({ type: 'set_mcp_tools', tools }) as Promise<void>;
  }

  /**
   * Register the handler invoked when the Worker upcalls a tool.
   *
   * The handler runs the tool (typically an MCP call) on this side and
   * returns the result; the client marshals success/failure back to the
   * Worker via `tool_call_response`.
   */
  setToolCallHandler(handler: ToolCallHandler | null): void {
    this.toolCallHandler = handler;
  }

  subscribe(listener: (envelope: RpcAgentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Session-loaded events are a separate stream from agent envelopes. */
  onSessionLoaded(listener: (event: RpcSessionLoadedEvent) => void): () => void {
    this.sessionLoadedListeners.add(listener);
    return () => this.sessionLoadedListeners.delete(listener);
  }

  // --------------------------------------------------------------------------
  // Session commands (M5)
  // --------------------------------------------------------------------------

  listSessions(): Promise<SessionSummary[]> {
    return this.send({ type: 'list_sessions' }) as Promise<SessionSummary[]>;
  }

  loadSession(sessionId: string): Promise<void> {
    return this.send({ type: 'load_session', sessionId }) as Promise<void>;
  }

  newSession(parentSession?: string): Promise<{ sessionId: string }> {
    return this.send({ type: 'new_session', parentSession }) as Promise<{
      sessionId: string;
    }>;
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.send({ type: 'delete_session', sessionId }) as Promise<void>;
  }

  setSessionName(name: string): Promise<void> {
    return this.send({ type: 'set_session_name', name }) as Promise<void>;
  }

  getSessionMeta(): Promise<SessionMeta | null> {
    return this.send({ type: 'get_session_meta' }) as Promise<SessionMeta | null>;
  }

  dispose(): void {
    this.unsubscribe();
    for (const p of this.pending.values()) {
      p.reject(new Error('RpcClient disposed'));
    }
    this.pending.clear();
    this.listeners.clear();
    this.sessionLoadedListeners.clear();
    this.toolCallHandler = null;
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
    if (raw.type === 'tool_call_request') {
      void this.handleToolCallRequest(raw);
      return;
    }
    if (raw.type === 'session_loaded') {
      for (const listener of this.sessionLoadedListeners) listener(raw);
      return;
    }
    if (raw.type === 'response') {
      const pending = this.pending.get(raw.id);
      if (!pending) return;
      this.pending.delete(raw.id);
      if (raw.success) {
        pending.resolve('data' in raw ? raw.data : undefined);
      } else {
        pending.reject(deserializeError(raw.error));
      }
    }
  }

  private async handleToolCallRequest(req: RpcToolCallRequest): Promise<void> {
    const handler = this.toolCallHandler;
    if (!handler) {
      void this.send({
        type: 'tool_call_response',
        callId: req.callId,
        ok: false,
        error: serializeError(new Error(`No handler for tool ${req.toolName}`)),
      });
      return;
    }
    try {
      const result = await handler(req.toolName, req.args);
      void this.send({
        type: 'tool_call_response',
        callId: req.callId,
        ok: true,
        result,
      });
    } catch (err) {
      void this.send({
        type: 'tool_call_response',
        callId: req.callId,
        ok: false,
        error: serializeError(err),
      });
    }
  }
}

function isEnvelope(value: unknown): value is RpcResponse | RpcEventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'response' || t === 'event' || t === 'tool_call_request' || t === 'session_loaded';
}
