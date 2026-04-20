/** Token estimation (char/4 heuristic) and context-window threshold check. */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Usage } from '@mariozechner/pi-ai';
import type { CompactionSettings } from './types';

/** Estimate tokens for one message using a char/4 heuristic. */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  switch (message.role) {
    case 'user': {
      const content = (message as { content: unknown }).content;
      if (typeof content === 'string') {
        chars = content.length;
      } else if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; text?: string }>) {
          if (block.type === 'text' && block.text) chars += block.text.length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case 'assistant': {
      for (const block of (message as AssistantMessage).content) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'thinking') chars += block.thinking.length;
        else if (block.type === 'toolCall')
          chars += block.name.length + JSON.stringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    }
    case 'toolResult': {
      const content = (message as { content: unknown }).content;
      if (typeof content === 'string') {
        chars = content.length;
      } else if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; text?: string }>) {
          if (block.type === 'text' && block.text) chars += block.text.length;
          else if (block.type === 'image') chars += 4800;
        }
      }
      return Math.ceil(chars / 4);
    }
    default:
      return 0;
  }
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role !== 'assistant') return undefined;
  const a = msg as AssistantMessage;
  if (a.stopReason === 'aborted' || a.stopReason === 'error') return undefined;
  return a.usage;
}

function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Best-effort estimate of the total context tokens for a message list.
 * Prefers the most recent assistant usage (reported by the provider);
 * falls back to char/4 estimate across every message.
 */
export function estimateContextTokens(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (!usage) continue;
    let trailing = 0;
    for (let j = i + 1; j < messages.length; j++) trailing += estimateTokens(messages[j]);
    return calculateContextTokens(usage) + trailing;
  }
  let total = 0;
  for (const m of messages) total += estimateTokens(m);
  return total;
}

/** Threshold check: above `contextWindow - reserveTokens` we compact. */
export function shouldCompact(
  messages: AgentMessage[],
  contextWindow: number,
  settings: CompactionSettings
): boolean {
  if (!settings.enabled) return false;
  const tokens = estimateContextTokens(messages);
  return tokens > contextWindow - settings.reserveTokens;
}
