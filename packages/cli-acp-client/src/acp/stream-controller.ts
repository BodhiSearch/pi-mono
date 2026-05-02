/**
 * StreamController owns the long-lived `client.onSessionUpdate`
 * subscription and the streaming state machine. Mirrors the
 * web-acp `useAcpStreaming` + `useAcp` reducer wiring, scaled to a
 * non-React Node host.
 *
 * Responsibilities:
 *   - subscribe once at boot (no per-prompt subscribe/unsubscribe);
 *   - dispatch every `session/update` through `streamingReducer`;
 *   - emit `ShellMessage` to the renderer on every transition that
 *     affects what the user sees (assistant chunks, tool-call status,
 *     MCP lifecycle status lines, builtin replies);
 *   - route `_meta.bodhi.builtin.action` to the host's
 *     `BuiltinActionDispatcher`;
 *   - expose `getState()` so commands like `/mcp list` can render
 *     toggle + connection state without re-walking the wire.
 *
 * The controller is renderer-shape-agnostic: it accepts a
 * `RendererSink` (just the bits of `Renderer` we need) so the
 * line-mode and pi-tui renderers behave identically.
 */

import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type { AnyBodhiBuiltinAction } from '@bodhiapp/web-acp-agent';
import type { AcpClient, SessionUpdateListener } from './client';
import {
  extractMcpMeta,
  getAssistantText,
  initialStreamingState,
  streamingReducer,
  type AgentMessage,
  type StreamingAction,
  type StreamingState,
  type ToolCallView,
} from './streaming-reducer';
import type { ShellMessage } from '../shell/types';

export interface RendererSink {
  emit(message: ShellMessage): void;
}

export interface BuiltinActionContext {
  readonly action: AnyBodhiBuiltinAction;
  readonly sessionId: string | null;
  readonly messages: AgentMessage[];
}

export type BuiltinActionDispatcher = (ctx: BuiltinActionContext) => void | Promise<void>;

export type StateChangeListener = (state: StreamingState) => void;

export interface StreamControllerOptions {
  client: AcpClient;
  /** Used for emitting assistant + tool messages. */
  renderer: RendererSink;
  /**
   * Optional dispatcher for `_meta.bodhi.builtin.action`. When
   * provided, the controller forwards each action with the current
   * full message history so /copy-style operations have everything
   * they need.
   */
  dispatchBuiltinAction?: BuiltinActionDispatcher;
  /** Resolves the current sessionId at action-dispatch time. */
  getSessionId?: () => string | null;
  /**
   * Render the streaming state into ShellMessages. Default: emit
   * assistant chunks under `assistant-<turn>` and tool calls under
   * the toolCallId. Renderers may want richer formatting; pass a
   * custom function to override.
   */
  renderToolCall?: (view: ToolCallView) => ShellMessage | null;
}

export class StreamController {
  #state: StreamingState = initialStreamingState;
  #unsubscribe: (() => void) | null = null;
  readonly #client: AcpClient;
  readonly #renderer: RendererSink;
  readonly #dispatchBuiltinAction?: BuiltinActionDispatcher;
  readonly #getSessionId?: () => string | null;
  readonly #renderToolCall: (view: ToolCallView) => ShellMessage | null;
  readonly #stateListeners = new Set<StateChangeListener>();
  /**
   * Track which actions we've already dispatched so the same
   * `_meta.bodhi.builtin.action` envelope on a later session/update
   * doesn't fire twice. Keyed by streamingMessageId; cleared on
   * turn-end and reset.
   */
  #dispatchedActionIds = new Set<string>();

  constructor(opts: StreamControllerOptions) {
    this.#client = opts.client;
    this.#renderer = opts.renderer;
    this.#dispatchBuiltinAction = opts.dispatchBuiltinAction;
    this.#getSessionId = opts.getSessionId;
    this.#renderToolCall = opts.renderToolCall ?? defaultRenderToolCall;
  }

  start(): void {
    if (this.#unsubscribe) return;
    const listener: SessionUpdateListener = notification => {
      this.dispatch({ type: 'session-update', notif: notification });
    };
    this.#unsubscribe = this.#client.onSessionUpdate(listener);
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  getState(): StreamingState {
    return this.#state;
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  dispatch(action: StreamingAction): void {
    const prev = this.#state;
    const next = streamingReducer(prev, action);
    this.#state = next;
    if (action.type === 'turn-end' || action.type === 'reset') {
      this.#dispatchedActionIds.clear();
    }
    this.#emitTransitionMessages(prev, next, action);
    if (next !== prev) {
      for (const l of this.#stateListeners) {
        try {
          l(next);
        } catch (err) {
          console.error('[stream-controller] state listener threw:', err);
        }
      }
    }
  }

  /**
   * Capture the current streaming assistant message, if any. Useful
   * for `prompt`-driven turn-end actions that want the final text
   * from the same accumulator the renderer already saw.
   */
  currentStreamingMessage(): AgentMessage | undefined {
    return this.#state.streamingMessage;
  }

  #emitTransitionMessages(
    prev: StreamingState,
    next: StreamingState,
    action: StreamingAction
  ): void {
    if (action.type !== 'session-update') return;

    const mcpMeta = extractMcpMeta(action.notif._meta);
    if (mcpMeta) {
      const tools =
        mcpMeta.tools && mcpMeta.tools.length > 0 ? ` (${mcpMeta.tools.length} tools)` : '';
      const errSuffix = mcpMeta.error ? ` — ${mcpMeta.error}` : '';
      this.#renderer.emit({
        kind: 'system',
        id: `mcp:${mcpMeta.server}`,
        text: `[mcp] ${mcpMeta.server}: ${mcpMeta.state}${tools}${errSuffix}`,
      });
      return;
    }

    if (next.isReplaying) return;

    const update = action.notif.update;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const streamingMsg = next.streamingMessage;
      if (!streamingMsg) return;
      const text = getAssistantText(streamingMsg);
      if (!text) return;
      const renderId = next.streamingMessageId
        ? `assistant-turn-${next.turnIndex}:${next.streamingMessageId}`
        : `assistant-turn-${next.turnIndex}`;
      this.#renderer.emit({
        kind: 'assistant',
        id: renderId,
        text,
      });

      const builtinTag = streamingMsg._builtin;
      if (builtinTag?.action && this.#dispatchBuiltinAction) {
        const dispatchKey = `${renderId}:${builtinTag.command}:${builtinTag.action.kind}`;
        if (!this.#dispatchedActionIds.has(dispatchKey)) {
          this.#dispatchedActionIds.add(dispatchKey);
          const sessionId = this.#getSessionId?.() ?? null;
          void this.#dispatchBuiltinAction({
            action: builtinTag.action,
            sessionId,
            messages: [...next.messages],
          });
        }
      }
      return;
    }

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const view = next.toolCalls.get((update as { toolCallId: string }).toolCallId);
      if (!view) return;
      const message = this.#renderToolCall(view);
      if (!message) return;
      this.#renderer.emit(message);
      return;
    }

    if (update.sessionUpdate === 'available_commands_update') {
      // Available-commands updates are surfaced via state listeners
      // so the dispatcher / autocomplete can pick them up. We don't
      // emit a renderer line — too noisy. Suppress unused-warning by
      // referencing prev.
      void prev;
      return;
    }
  }
}

function defaultRenderToolCall(view: ToolCallView): ShellMessage {
  const status = view.status;
  const baseText = `[${status}] ${view.title}`;
  const text = view.text ? `${baseText}\n${view.text}` : baseText;
  return { id: view.toolCallId, kind: 'tool', text };
}

export function availableCommandNames(commands: AvailableCommand[]): string[] {
  return commands.map(c => c.name);
}
