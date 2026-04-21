import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { LlmAuthCredential } from '../llm/types';
import type { SessionMeta, SessionSummary } from '../core/session/types';
import { deserializeError, serializeError } from './error';
import type {
  ExtensionDescriptor,
  McpToolDescriptor,
  RpcAgentEventEnvelope,
  RpcCommand,
  RpcCompactionEvent,
  RpcEventEnvelope,
  RpcExtensionErrorEvent,
  RpcExtensionStatesEvent,
  RpcResponse,
  RpcSessionLoadedEvent,
  RpcSessionState,
  RpcToolCallRequest,
  SlashCommandInfo,
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
  private readonly compactionListeners = new Set<(event: RpcCompactionEvent) => void>();
  private readonly extensionStatesListeners = new Set<(event: RpcExtensionStatesEvent) => void>();
  private readonly extensionErrorListeners = new Set<(event: RpcExtensionErrorEvent) => void>();
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

  /**
   * Set the active model by `(provider, modelId)`. Shape mirrors
   * coding-agent `rpc-client.ts::setModel`. Returns the fully-resolved
   * `Model<Api>` from the Worker-side registry.
   */
  setModel(provider: string, modelId: string): Promise<Model<Api>> {
    return this.send({ type: 'set_model', provider, modelId }) as Promise<Model<Api>>;
  }

  /**
   * Ask the Worker for its model catalog. The Worker delegates to its
   * injected `LlmProvider`; for Bodhi this triggers a fresh fetch of
   * `/bodhi/v1/models` on every call.
   */
  getAvailableModels(): Promise<Model<Api>[]> {
    return this.send({ type: 'get_available_models' }).then(
      data => (data as { models: Model<Api>[] }).models
    );
  }

  setSystemPrompt(prompt: string): Promise<void> {
    return this.send({ type: 'set_system_prompt', prompt }) as Promise<void>;
  }

  reset(): Promise<void> {
    return this.send({ type: 'reset' }) as Promise<void>;
  }

  /**
   * Rotate the worker-side LLM auth credential. Pass `null` to clear
   * the credential (e.g. on logout).
   */
  setAuthToken(credential: LlmAuthCredential | null): Promise<void> {
    return this.send({ type: 'set_auth_token', credential }) as Promise<void>;
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

  // --------------------------------------------------------------------------
  // Session-tree commands (M6)
  // --------------------------------------------------------------------------

  forkSession(fromEntryId: string): Promise<{ sessionId: string }> {
    return this.send({ type: 'fork_session', fromEntryId }) as Promise<{
      sessionId: string;
    }>;
  }

  navigateToLeaf(entryId: string): Promise<void> {
    return this.send({ type: 'navigate_to_leaf', entryId }) as Promise<void>;
  }

  // --------------------------------------------------------------------------
  // Compaction commands (M7)
  // --------------------------------------------------------------------------

  compactNow(): Promise<void> {
    return this.send({ type: 'compact_now' }) as Promise<void>;
  }

  /** Compaction lifecycle events are a separate stream from agent envelopes. */
  onCompactionEvent(listener: (event: RpcCompactionEvent) => void): () => void {
    this.compactionListeners.add(listener);
    return () => this.compactionListeners.delete(listener);
  }

  // --------------------------------------------------------------------------
  // Slash commands (M9)
  // --------------------------------------------------------------------------

  /**
   * Fetch the unified slash-command listing (builtins + prompt
   * templates loaded from the mounted vault). Feeds the
   * autocomplete palette.
   */
  listCommands(): Promise<SlashCommandInfo[]> {
    return this.send({ type: 'list_commands' }) as Promise<SlashCommandInfo[]>;
  }

  /**
   * Re-scan the vault's `.pi/prompts/` for template changes and
   * return the refreshed listing. Invoked by the `/reload` builtin.
   */
  reloadCommands(): Promise<SlashCommandInfo[]> {
    return this.send({ type: 'reload_commands' }) as Promise<SlashCommandInfo[]>;
  }

  // --------------------------------------------------------------------------
  // Extensions (M8)
  // --------------------------------------------------------------------------

  /**
   * Return the current extension descriptor list (name, enabled,
   * loaded, error). Feeds the main-thread ExtensionsPanel.
   */
  listExtensions(): Promise<ExtensionDescriptor[]> {
    return this.send({ type: 'list_extensions' }) as Promise<ExtensionDescriptor[]>;
  }

  /**
   * Push a new enabled-state map to the worker. The worker applies the
   * change at the next `agent_end` boundary and emits a follow-up
   * `extension_states` event when reconciliation completes. Returns
   * the descriptor list that was current at dispatch time so the caller
   * can render immediately; the subsequent event supersedes it.
   */
  setExtensionStates(states: Record<string, boolean>): Promise<ExtensionDescriptor[]> {
    return this.send({ type: 'set_extension_states', states }) as Promise<ExtensionDescriptor[]>;
  }

  /** Extension-state change events are a separate stream from agent envelopes. */
  onExtensionStates(listener: (event: RpcExtensionStatesEvent) => void): () => void {
    this.extensionStatesListeners.add(listener);
    return () => this.extensionStatesListeners.delete(listener);
  }

  /** Extension-error events carry hook/factory throw diagnostics. */
  onExtensionError(listener: (event: RpcExtensionErrorEvent) => void): () => void {
    this.extensionErrorListeners.add(listener);
    return () => this.extensionErrorListeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribe();
    for (const p of this.pending.values()) {
      p.reject(new Error('RpcClient disposed'));
    }
    this.pending.clear();
    this.listeners.clear();
    this.sessionLoadedListeners.clear();
    this.compactionListeners.clear();
    this.extensionStatesListeners.clear();
    this.extensionErrorListeners.clear();
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
    if (raw.type === 'compaction_start' || raw.type === 'compaction_end') {
      for (const listener of this.compactionListeners) listener(raw);
      return;
    }
    if (raw.type === 'extension_states') {
      for (const listener of this.extensionStatesListeners) listener(raw);
      return;
    }
    if (raw.type === 'extension_error') {
      for (const listener of this.extensionErrorListeners) listener(raw);
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
  return (
    t === 'response' ||
    t === 'event' ||
    t === 'tool_call_request' ||
    t === 'session_loaded' ||
    t === 'compaction_start' ||
    t === 'compaction_end' ||
    t === 'extension_states' ||
    t === 'extension_error'
  );
}
