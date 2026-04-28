import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AnyBodhiBuiltinAction, BodhiBuiltinTag } from '@/acp';

/**
 * Read the `_builtin` marker stamped onto a chat message by either:
 * - `useAcp.sendMessage` at send time (client-side detection from
 *   advertised commands), or
 * - the worker's `bodhi/getSession` snapshot during reload.
 *
 * Returns `undefined` for ordinary LLM-driven messages.
 */
export function getBuiltinTag(msg: AgentMessage): BodhiBuiltinTag | undefined {
  return (msg as unknown as { _builtin?: BodhiBuiltinTag })._builtin;
}

export function withBuiltinTag<T extends AgentMessage>(msg: T, tag: BodhiBuiltinTag): T {
  return {
    ...(msg as unknown as Record<string, unknown>),
    _builtin: tag,
  } as unknown as T;
}

/**
 * Extract `_meta.bodhi.builtin` from a `SessionNotification`'s `_meta`
 * envelope. Mirrors `extractMcpMeta` in `useAcp.ts`.
 */
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

/**
 * Validate a wire-shape `action` blob against the per-kind contract in
 * `acp/index.ts`. Unknown kinds and malformed payloads return
 * `undefined` so the dispatcher only ever sees fully-narrowed values.
 */
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

function extractText(msg: AgentMessage): string {
  const content = (msg as unknown as { content: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      'type' in part &&
      (part as { type: unknown }).type === 'text' &&
      'text' in part &&
      typeof (part as { text: unknown }).text === 'string'
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join('');
}

/**
 * Build a simple markdown transcript suitable for clipboard copy.
 * Filters out anything non-conversational: tool-result messages,
 * tool-call-only assistant messages, and built-in turns themselves.
 * Empty user/assistant text is skipped so the output stays clean
 * even when the conversation contains tool-call-only turns.
 */
export function renderConversationMarkdown(messages: AgentMessage[]): string {
  const blocks: string[] = [];
  for (const msg of messages) {
    if (getBuiltinTag(msg)) continue;
    if (msg.role === 'toolResult') continue;
    const text = extractText(msg).trim();
    if (!text) continue;
    if (msg.role === 'user') {
      blocks.push(`**You:**\n\n${text}`);
    } else if (msg.role === 'assistant') {
      blocks.push(`**Assistant:**\n\n${text}`);
    }
  }
  return blocks.join('\n\n');
}
