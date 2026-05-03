import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { isBuiltinName } from '@bodhiapp/web-acp-agent';
import type { AnyBodhiBuiltinAction, BodhiBuiltinTag } from '@/acp/index';
import type { McpConnectionMeta } from '@/mcp/types';

export function parseMcpStateParams(
  params: Record<string, unknown>
): McpConnectionMeta | undefined {
  const server = params.server;
  const state = params.state;
  if (typeof server !== 'string') return undefined;
  if (
    state !== 'disconnected' &&
    state !== 'connecting' &&
    state !== 'connected' &&
    state !== 'error'
  ) {
    console.warn('[acp/message-shape] parseMcpStateParams: unknown mcp state value:', state);
    return undefined;
  }
  const out: McpConnectionMeta = { server, state };
  if (typeof params.error === 'string') out.error = params.error;
  if (Array.isArray(params.tools) && params.tools.every(t => typeof t === 'string')) {
    out.tools = params.tools as string[];
  }
  return out;
}

export function emptyAssistantMessage(): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
  } as unknown as AgentMessage;
}

export function getAssistantText(msg: AgentMessage): string {
  const content = (msg as unknown as { content: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      (block as { type: unknown }).type === 'text' &&
      'text' in block
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('');
}

export function withAssistantText(msg: AgentMessage, text: string): AgentMessage {
  return {
    ...(msg as unknown as Record<string, unknown>),
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

export function userMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

/** Mirrors the worker's `/<name>` prefix rule so bubble tagging matches dispatch. */
export function detectBuiltinTag(text: string): BodhiBuiltinTag | undefined {
  if (!text.startsWith('/')) return undefined;
  const rest = text.slice(1);
  const wsMatch = rest.match(/\s/);
  const name = wsMatch ? rest.slice(0, wsMatch.index) : rest;
  if (!isBuiltinName(name)) return undefined;
  return { command: name };
}

export function toolCallContentText(
  content:
    | Array<{ type?: unknown; content?: { type?: unknown; text?: unknown } }>
    | null
    | undefined
): string {
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

/** Returns `undefined` for malformed payloads so non-Bodhi agents can't crash `dispatchAction`. */
export function parseBuiltinActionParams(
  params: Record<string, unknown>
): AnyBodhiBuiltinAction | undefined {
  const action = (params as { action?: unknown }).action;
  if (!action || typeof action !== 'object') return undefined;
  const kind = (action as { kind?: unknown }).kind;
  if (kind === 'copy') return action as AnyBodhiBuiltinAction;
  if (kind === 'mcp-add' || kind === 'mcp-remove') {
    const inner = (action as { params?: unknown }).params;
    if (!inner || typeof inner !== 'object') return undefined;
    if (typeof (inner as { url?: unknown }).url !== 'string') return undefined;
    return action as AnyBodhiBuiltinAction;
  }
  return undefined;
}
