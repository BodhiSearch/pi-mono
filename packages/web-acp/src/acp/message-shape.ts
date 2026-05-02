import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { isBuiltinName } from '@bodhiapp/web-acp-agent';
import type { BodhiBuiltinTag } from '@/acp/index';
import type { McpConnectionMeta } from '@/mcp/types';

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

/**
 * Recognise an agent-handled built-in invocation in raw user input
 * (M4 phase B). Mirrors the worker's prefix rule (`/<name>` then
 * end-of-string or whitespace) so client-side bubble tagging stays
 * aligned with how the worker decides to dispatch the command.
 */
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
