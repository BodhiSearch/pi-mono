import type { AvailableCommand, SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import {
  emptyAssistantMessage,
  extractMcpMeta,
  getAssistantText,
  mapToolStatus,
  toolCallContentText,
  withAssistantText,
} from '@/acp/message-shape';
import { extractBuiltinMeta, getBuiltinTag, withBuiltinTag } from '@/lib/builtin-format';
import type { McpConnectionMeta } from '@/mcp/types';

export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  title: string;
  status: 'in_progress' | 'completed' | 'failed' | 'pending';
  rawInput?: unknown;
  rawOutput?: unknown;
  text: string;
  turn: number;
}

const EMPTY_AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([]);
const EMPTY_MCP_STATES: Record<string, McpConnectionMeta> = Object.freeze({});

export interface StreamingState {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | undefined;
  streamingMessageId: string | undefined;
  toolCalls: Map<string, ToolCallView>;
  turnIndex: number;
  isStreaming: boolean;
  isReplaying: boolean;
  availableCommands: readonly AvailableCommand[];
  mcpStates: Record<string, McpConnectionMeta>;
}

export const initialStreamingState: StreamingState = Object.freeze({
  messages: [],
  streamingMessage: undefined,
  streamingMessageId: undefined,
  toolCalls: new Map<string, ToolCallView>(),
  turnIndex: 0,
  isStreaming: false,
  isReplaying: false,
  availableCommands: EMPTY_AVAILABLE_COMMANDS,
  mcpStates: EMPTY_MCP_STATES,
});

export type StreamingAction =
  /** User clicked send: append user message, clear streaming, mark in-flight. */
  | { type: 'turn-start'; userMessage: AgentMessage }
  /** Prompt resolved: append final assistant message (unless cancelled), bump turnIndex. */
  | { type: 'turn-end'; stopReason: string; finalMessage?: AgentMessage }
  /** loadSession entry: clear streaming, mark replaying so live notifications get suppressed. */
  | { type: 'load-start' }
  /** loadSession exit. `messages` provided on success → full snapshot replace; omitted on error → just clear replaying. */
  | { type: 'load-end'; messages?: AgentMessage[] }
  /** A `session/update` arrived from the worker. */
  | { type: 'session-update'; notif: SessionNotification }
  /** clearMessages / deleteSession-active / auth-loss: forget everything, fresh slate. */
  | { type: 'reset' };

/**
 * Pure reducer for the host-side prompt-turn state machine. The
 * `'session-update'` action mirrors the dispatcher previously inlined
 * in `useAcp`'s subscription effect — `agent_message_chunk`,
 * `tool_call`, `tool_call_update`, `available_commands_update`, and
 * the MCP-meta side channel are routed identically. The replay guard
 * is now part of state rather than a ref so it observes synchronously
 * with each notification.
 */
export function streamingReducer(state: StreamingState, action: StreamingAction): StreamingState {
  switch (action.type) {
    case 'turn-start':
      return {
        ...state,
        messages: [...state.messages, action.userMessage],
        streamingMessage: undefined,
        streamingMessageId: undefined,
        isStreaming: true,
      };
    case 'turn-end': {
      const append =
        action.finalMessage && action.stopReason !== 'cancelled'
          ? [...state.messages, action.finalMessage]
          : state.messages;
      return {
        ...state,
        messages: append,
        streamingMessage: undefined,
        streamingMessageId: undefined,
        isStreaming: false,
        turnIndex: state.turnIndex + 1,
      };
    }
    case 'load-start':
      return {
        ...state,
        streamingMessage: undefined,
        streamingMessageId: undefined,
        isReplaying: true,
      };
    case 'load-end':
      if (action.messages) {
        return {
          ...state,
          messages: action.messages,
          toolCalls: new Map(),
          turnIndex: 0,
          isReplaying: false,
        };
      }
      return { ...state, isReplaying: false };
    case 'reset':
      return {
        ...initialStreamingState,
        // Preserve `availableCommands` and `mcpStates` empties as
        // frozen identities so reference equality holds across resets.
        toolCalls: new Map(),
      };
    case 'session-update':
      return applySessionUpdate(state, action.notif);
  }
}

function applySessionUpdate(
  state: StreamingState,
  notification: SessionNotification
): StreamingState {
  // MCP connection lifecycle events ride on empty `agent_message_chunk`
  // notifications with `_meta.bodhi.mcp` set; they must be routed
  // regardless of replay guard.
  const mcpMeta = extractMcpMeta(notification._meta);
  if (mcpMeta) {
    return {
      ...state,
      mcpStates: { ...state.mcpStates, [mcpMeta.server]: mcpMeta },
    };
  }
  // `available_commands_update` is a per-session refresh that must
  // hydrate the picker even when we're replaying — the latest refresh
  // after the replay is the freshest list and overrides any stale
  // persisted entry.
  if (notification.update.sessionUpdate === 'available_commands_update') {
    const list = notification.update.availableCommands ?? [];
    return {
      ...state,
      availableCommands: list.length > 0 ? list : EMPTY_AVAILABLE_COMMANDS,
    };
  }
  if (state.isReplaying) return state;
  const update = notification.update;
  // M4 phase B: built-in slash commands ride the standard
  // `agent_message_chunk` wire with `_meta.bodhi.builtin` set so the
  // bubble renders muted with a "not sent to LLM" badge. The tag is
  // applied to the streaming message so it travels through the
  // existing chunk-accumulation path.
  const builtinMeta = extractBuiltinMeta(notification._meta);
  if (update.sessionUpdate === 'agent_message_chunk') {
    const content = update.content;
    if (!content || content.type !== 'text') return state;
    const delta = content.text ?? '';
    if (!delta) return state;

    const messageId = update.messageId ?? undefined;
    let streamingMessage = state.streamingMessage;
    let streamingMessageId = state.streamingMessageId;
    if (messageId && messageId !== streamingMessageId) {
      streamingMessageId = messageId;
      streamingMessage = emptyAssistantMessage();
    }

    const current = streamingMessage ?? emptyAssistantMessage();
    const nextText = getAssistantText(current) + delta;
    let next = withAssistantText(current, nextText);
    const carriedTag = builtinMeta ?? getBuiltinTag(current);
    if (carriedTag) next = withBuiltinTag(next, carriedTag);
    return {
      ...state,
      streamingMessage: next,
      streamingMessageId,
    };
  }
  if (update.sessionUpdate === 'tool_call') {
    const view: ToolCallView = {
      toolCallId: update.toolCallId,
      toolName: update.title?.split(':')[0] ?? 'tool',
      title: update.title ?? update.toolCallId,
      status: update.status === 'pending' ? 'pending' : 'in_progress',
      rawInput: update.rawInput,
      text: toolCallContentText(update.content),
      turn: state.turnIndex,
    };
    const toolCalls = new Map(state.toolCalls);
    toolCalls.set(update.toolCallId, view);
    return { ...state, toolCalls };
  }
  if (update.sessionUpdate === 'tool_call_update') {
    const existing = state.toolCalls.get(update.toolCallId);
    if (!existing) return state;
    const next: ToolCallView = {
      ...existing,
      status: mapToolStatus(update.status) ?? existing.status,
      rawOutput: update.rawOutput ?? existing.rawOutput,
      text: update.content ? toolCallContentText(update.content) : existing.text,
    };
    const toolCalls = new Map(state.toolCalls);
    toolCalls.set(update.toolCallId, next);
    return { ...state, toolCalls };
  }
  return state;
}
