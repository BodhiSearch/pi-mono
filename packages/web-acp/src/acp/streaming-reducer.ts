import type { SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import {
  emptyAssistantMessage,
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

/**
 * Streaming slice — fields that turn over per prompt-turn. Panel
 * actions (`config-options-init`, `mcp-state`, panel-affecting
 * `session-update` kinds) are no-ops; see {@link panelsReducer}.
 * `isReplaying` lives in state (not a ref) so the guard observes
 * synchronously with each notification.
 */
export interface StreamingState {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | undefined;
  streamingMessageId: string | undefined;
  toolCalls: Map<string, ToolCallView>;
  turnIndex: number;
  isStreaming: boolean;
  isReplaying: boolean;
}

export const initialStreamingState: StreamingState = Object.freeze({
  messages: [],
  streamingMessage: undefined,
  streamingMessageId: undefined,
  toolCalls: new Map<string, ToolCallView>(),
  turnIndex: 0,
  isStreaming: false,
  isReplaying: false,
});

/** Dispatched at both `streamingReducer` and `panelsReducer`; each ignores actions outside its slice. */
export type AcpAction =
  | { type: 'turn-start'; userMessage: AgentMessage }
  | { type: 'turn-end'; stopReason: string }
  | { type: 'load-start' }
  | { type: 'load-end'; messages?: AgentMessage[] }
  | { type: 'session-update'; notif: SessionNotification }
  | { type: 'config-options-init'; configOptions: SessionConfigOption[] }
  | { type: 'mcp-state'; meta: McpConnectionMeta }
  | { type: 'reset' };

export function streamingReducer(state: StreamingState, action: AcpAction): StreamingState {
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
      // Fold `streamingMessage` in here to close the commit/effect race
      // where the caller would have read a stale ref.
      const append =
        state.streamingMessage && action.stopReason !== 'cancelled'
          ? [...state.messages, state.streamingMessage]
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
        toolCalls: new Map(),
      };
    case 'session-update':
      return applySessionUpdate(state, action.notif);
    case 'config-options-init':
    case 'mcp-state':
      return state;
  }
}

function applySessionUpdate(
  state: StreamingState,
  notification: SessionNotification
): StreamingState {
  const update = notification.update;
  // Panel-owned kinds — no-op here so the default-warning stays narrow.
  if (
    update.sessionUpdate === 'available_commands_update' ||
    update.sessionUpdate === 'config_option_update'
  ) {
    return state;
  }
  if (state.isReplaying) return state;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const content = update.content;
      if (!content || content.type !== 'text') return state;
      const delta = content.text ?? '';
      if (!delta) return state;

      // Built-in slash commands carry `_meta.bodhi.builtin = { command }`
      // so the bubble renders muted; the optional `action` rides
      // `_bodhi/builtin/action` separately.
      const builtinMeta = extractBuiltinMeta(notification._meta);
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
      return { ...state, streamingMessage: next, streamingMessageId };
    }
    case 'tool_call': {
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
    case 'tool_call_update': {
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
    // Accepted but not yet rendered — explicit so the default warning
    // fires only on truly-unknown kinds.
    case 'user_message_chunk':
    case 'agent_thought_chunk':
    case 'plan':
    case 'current_mode_update':
    case 'session_info_update':
    case 'usage_update':
      return state;
    default: {
      const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
      console.warn('[streaming-reducer] unhandled SessionUpdate kind:', kind);
      return state;
    }
  }
}
