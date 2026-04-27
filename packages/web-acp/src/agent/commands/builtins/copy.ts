import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { BuiltinCommand } from './types';

/**
 * Determine whether the LLM-visible history has at least one assistant
 * message worth copying. The actual markdown payload is built on the
 * client at action-dispatch time; the worker only signals intent so
 * persistence stays minimal (no full conversation embedded in the
 * `BuiltinPayload`).
 */
function hasAnyAssistantText(messages: AgentMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string' && msg.content.trim().length > 0) return true;
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          part &&
          typeof part === 'object' &&
          'type' in part &&
          (part as { type: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string' &&
          (part as { text: string }).text.trim().length > 0
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export const copyCommand: BuiltinCommand = {
  name: 'copy',
  description: 'Copy the current conversation to the clipboard.',
  handler: (_args, ctx) => {
    if (!hasAnyAssistantText(ctx.inlineMessages)) {
      return { replyText: 'Nothing to copy yet.' };
    }
    return {
      replyText: 'Copied conversation to clipboard.',
      action: { kind: 'copy' },
    };
  },
};
