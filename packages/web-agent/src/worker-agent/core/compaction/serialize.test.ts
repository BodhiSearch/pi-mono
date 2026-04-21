import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, test } from 'vitest';
import { serializeConversation } from './serialize';

function userMsg(text: string): AgentMessage {
  return { role: 'user', content: text } as unknown as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

function toolResultMsg(text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'tc1',
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe('serializeConversation', () => {
  test('formats a user/assistant exchange as labelled plain text', () => {
    const result = serializeConversation([userMsg('hello'), assistantMsg('hi there')]);
    expect(result).toContain('[User]: hello');
    expect(result).toContain('[Assistant]: hi there');
  });

  test('handles array-content user messages', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'text', text: 'structured' }],
    } as unknown as AgentMessage;
    const result = serializeConversation([msg]);
    expect(result).toContain('[User]: structured');
  });

  test('truncates tool results exceeding 2000 chars', () => {
    const longResult = 'x'.repeat(3000);
    const result = serializeConversation([toolResultMsg(longResult)]);
    expect(result).toContain('[Tool result]:');
    expect(result).toContain('truncated');
    expect(result.length).toBeLessThan(longResult.length);
  });

  test('returns empty string for empty input', () => {
    expect(serializeConversation([])).toBe('');
  });
});
