/** Serialize AgentMessages into a plain-text transcript for the summarization LLM. */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${dropped} more characters truncated]`;
}

export function serializeConversation(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = (msg as { content: unknown }).content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as Array<{ type?: string; text?: string }>)
                .filter(c => c.type === 'text' && c.text)
                .map(c => c.text!)
                .join('')
            : '';
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }
    if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of (msg as AssistantMessage).content) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'thinking') thinkingParts.push(block.thinking);
        else if (block.type === 'toolCall') {
          const args = block.arguments as Record<string, unknown>;
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(', ');
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join('\n')}`);
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join('\n')}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`);
      continue;
    }
    if (msg.role === 'toolResult') {
      const content = (msg as { content: unknown }).content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as Array<{ type?: string; text?: string }>)
                .filter(c => c.type === 'text' && c.text)
                .map(c => c.text!)
                .join('')
            : '';
      if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
      continue;
    }
  }
  return parts.join('\n\n');
}
