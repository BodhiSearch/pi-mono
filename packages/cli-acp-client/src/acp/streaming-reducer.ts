/**
 * Streaming state machine for the CLI host. Mirrors
 * `packages/web-acp/src/acp/streaming-reducer.ts` shape-for-shape so
 * the same notification-routing decisions apply across both hosts.
 *
 * Adapted for Node:
 *   - no React-specific types,
 *   - `messages` is an array of structurally-typed AgentMessage,
 *   - `availableCommands` is mutable-array (no `readonly` Object.freeze).
 *
 * Owners: a single `StreamController` instance held by `AppContext`.
 * The controller subscribes once at boot to `client.onSessionUpdate`
 * and routes every notification through `applySessionUpdate`. Hosts
 * (line / pi-tui renderer) read from the controller instead of
 * subscribing themselves.
 */

import type { AvailableCommand, SessionNotification } from '@agentclientprotocol/sdk';
import {
  isBuiltinName,
  type AnyBodhiBuiltinAction,
  type BodhiBuiltinTag,
} from '@bodhiapp/web-acp-agent';

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool' | 'toolResult' | string;
  content: unknown;
  /** Stamped on built-in turns by the agent so /copy can filter them. */
  _builtin?: BodhiBuiltinTag;
  [key: string]: unknown;
}

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

export interface McpConnectionMeta {
  server: string;
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
  tools?: string[];
}

export interface StreamingState {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | undefined;
  streamingMessageId: string | undefined;
  toolCalls: Map<string, ToolCallView>;
  turnIndex: number;
  isStreaming: boolean;
  isReplaying: boolean;
  availableCommands: AvailableCommand[];
  mcpStates: Record<string, McpConnectionMeta>;
}

const EMPTY_AVAILABLE_COMMANDS: AvailableCommand[] = [];
const EMPTY_MCP_STATES: Record<string, McpConnectionMeta> = {};

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
}) as StreamingState;

export type StreamingAction =
  /** User submitted a prompt: append user message, mark in-flight. */
  | { type: 'turn-start'; userMessage: AgentMessage }
  /** Prompt resolved: append final assistant message, bump turnIndex. */
  | { type: 'turn-end'; stopReason: string; finalMessage?: AgentMessage }
  /** loadSession entry: clear streaming, mark replaying. */
  | { type: 'load-start' }
  /** loadSession exit. messages provided on success. */
  | { type: 'load-end'; messages?: AgentMessage[] }
  /** session/update arrived from the agent. */
  | { type: 'session-update'; notif: SessionNotification }
  /** clearMessages / deleteSession-active / auth-loss: forget everything. */
  | { type: 'reset' };

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
        toolCalls: new Map(),
        availableCommands: state.availableCommands,
        mcpStates: state.mcpStates,
      };
    case 'session-update':
      return applySessionUpdate(state, action.notif);
  }
}

function applySessionUpdate(
  state: StreamingState,
  notification: SessionNotification
): StreamingState {
  const mcpMeta = extractMcpMeta(notification._meta);
  if (mcpMeta) {
    return {
      ...state,
      mcpStates: { ...state.mcpStates, [mcpMeta.server]: mcpMeta },
    };
  }
  if (notification.update.sessionUpdate === 'available_commands_update') {
    const list = notification.update.availableCommands ?? [];
    return {
      ...state,
      availableCommands: list.length > 0 ? [...list] : EMPTY_AVAILABLE_COMMANDS,
    };
  }
  if (state.isReplaying) return state;
  const update = notification.update;
  const builtinMeta = extractBuiltinMeta(notification._meta);
  if (update.sessionUpdate === 'agent_message_chunk') {
    const content = update.content;
    if (!content || content.type !== 'text') return state;
    const delta = (content as { text?: string }).text ?? '';
    if (!delta) return state;

    const messageId = (update as { messageId?: string }).messageId;
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
    const tc = update as {
      toolCallId: string;
      title?: string;
      status?: string;
      rawInput?: unknown;
      content?: ToolCallContentBlocks;
    };
    const view: ToolCallView = {
      toolCallId: tc.toolCallId,
      toolName: tc.title?.split(':')[0] ?? 'tool',
      title: tc.title ?? tc.toolCallId,
      status: tc.status === 'pending' ? 'pending' : 'in_progress',
      rawInput: tc.rawInput,
      text: toolCallContentText(tc.content),
      turn: state.turnIndex,
    };
    const toolCalls = new Map(state.toolCalls);
    toolCalls.set(view.toolCallId, view);
    return { ...state, toolCalls };
  }
  if (update.sessionUpdate === 'tool_call_update') {
    const tc = update as {
      toolCallId: string;
      status?: string;
      rawOutput?: unknown;
      content?: ToolCallContentBlocks;
    };
    const existing = state.toolCalls.get(tc.toolCallId);
    if (!existing) return state;
    const next: ToolCallView = {
      ...existing,
      status: mapToolStatus(tc.status) ?? existing.status,
      rawOutput: tc.rawOutput ?? existing.rawOutput,
      text: tc.content ? toolCallContentText(tc.content) : existing.text,
    };
    const toolCalls = new Map(state.toolCalls);
    toolCalls.set(tc.toolCallId, next);
    return { ...state, toolCalls };
  }
  return state;
}

type ToolCallContentBlocks =
  | Array<{ type?: unknown; content?: { type?: unknown; text?: unknown } }>
  | null
  | undefined;

export function extractMcpMeta(meta: unknown): McpConnectionMeta | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const bodhi = (meta as { bodhi?: unknown }).bodhi;
  if (!bodhi || typeof bodhi !== 'object') return undefined;
  const mcp = (bodhi as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== 'object') return undefined;
  const rec = mcp as Record<string, unknown>;
  const server = rec.server;
  const state = rec.state;
  if (typeof server !== 'string') return undefined;
  if (
    state !== 'disconnected' &&
    state !== 'connecting' &&
    state !== 'connected' &&
    state !== 'error'
  ) {
    return undefined;
  }
  const out: McpConnectionMeta = { server, state };
  if (typeof rec.error === 'string') out.error = rec.error;
  if (Array.isArray(rec.tools) && rec.tools.every(t => typeof t === 'string')) {
    out.tools = rec.tools as string[];
  }
  return out;
}

export function extractBuiltinMeta(meta: unknown): BodhiBuiltinTag | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const bodhi = (meta as { bodhi?: unknown }).bodhi;
  if (!bodhi || typeof bodhi !== 'object') return undefined;
  const builtin = (bodhi as { builtin?: unknown }).builtin;
  if (!builtin || typeof builtin !== 'object') return undefined;
  const rec = builtin as Record<string, unknown>;
  if (typeof rec.command !== 'string') return undefined;
  const out: BodhiBuiltinTag = { command: rec.command };
  const narrowed = narrowBuiltinAction(rec.action);
  if (narrowed) out.action = narrowed;
  return out;
}

function narrowBuiltinAction(input: unknown): AnyBodhiBuiltinAction | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  const kind = rec.kind;
  if (typeof kind !== 'string') return undefined;
  if (kind === 'copy') return { kind: 'copy' };
  if (kind === 'mcp-add' || kind === 'mcp-remove') {
    const params = rec.params;
    if (!params || typeof params !== 'object') return undefined;
    const url = (params as { url?: unknown }).url;
    if (typeof url !== 'string') return undefined;
    return { kind, params: { url } };
  }
  return undefined;
}

export function emptyAssistantMessage(): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
  };
}

export function userMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

/**
 * Detect a built-in slash invocation in raw user input. Mirrors the
 * agent's `findBuiltin` prefix rule (`/<name>` then end-of-string or
 * whitespace) so client-side bubble tagging matches how the agent
 * decides to dispatch.
 */
export function detectBuiltinTag(text: string): BodhiBuiltinTag | undefined {
  if (!text.startsWith('/')) return undefined;
  const rest = text.slice(1);
  const wsMatch = rest.match(/\s/);
  const name = wsMatch ? rest.slice(0, wsMatch.index) : rest;
  if (!isBuiltinName(name)) return undefined;
  return { command: name };
}

export function getAssistantText(msg: AgentMessage): string {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      (block as { type: unknown }).type === 'text' &&
      'text' in block &&
      typeof (block as { text: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('');
}

export function withAssistantText(msg: AgentMessage, text: string): AgentMessage {
  return {
    ...msg,
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
}

export function getBuiltinTag(msg: AgentMessage): BodhiBuiltinTag | undefined {
  return msg._builtin;
}

export function withBuiltinTag(msg: AgentMessage, tag: BodhiBuiltinTag): AgentMessage {
  return { ...msg, _builtin: tag };
}

export function toolCallContentText(content: ToolCallContentBlocks): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      block.type === 'content' &&
      block.content &&
      block.content.type === 'text' &&
      typeof block.content.text === 'string'
    ) {
      parts.push(block.content.text);
    }
  }
  return parts.join('\n');
}

export function mapToolStatus(
  status: string | undefined
): 'in_progress' | 'completed' | 'failed' | 'pending' | undefined {
  if (status === 'in_progress' || status === 'completed' || status === 'failed') return status;
  if (status === 'pending') return 'pending';
  return undefined;
}
