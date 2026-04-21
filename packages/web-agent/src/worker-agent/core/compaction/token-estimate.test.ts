import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { describe, expect, test } from 'vitest';
import { DEFAULT_COMPACTION_SETTINGS } from './types';
import { estimateContextTokens, estimateTokens, shouldCompact } from './token-estimate';

function user(text: string): AgentMessage {
  return { role: 'user', content: text } as unknown as AgentMessage;
}

function assistant(text: string, usageTotal?: number): AgentMessage {
  const msg: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'test',
    model: 'test-model',
    stopReason: 'stop',
    timestamp: Date.now(),
    ...(usageTotal !== undefined
      ? {
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: usageTotal,
          },
        }
      : {}),
  } as unknown as AssistantMessage;
  return msg as unknown as AgentMessage;
}

function toolResult(text: string): AgentMessage {
  return {
    role: 'toolResult',
    content: [{ type: 'text', text }],
    toolCallId: 'call-1',
    toolName: 'read',
  } as unknown as AgentMessage;
}

describe('estimateTokens', () => {
  test('user string content → chars/4 ceil', () => {
    expect(estimateTokens(user('abcd'))).toBe(1);
    expect(estimateTokens(user('a'.repeat(40)))).toBe(10);
  });

  test('assistant content counts text + thinking + toolCall args', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'thought' },
        { type: 'toolCall', name: 'read', arguments: { path: '/vault/a.txt' } },
      ],
      provider: 'test',
      model: 'test',
      stopReason: 'stop',
      timestamp: 0,
    } as unknown as AgentMessage;
    const chars =
      'hello'.length +
      'thought'.length +
      'read'.length +
      JSON.stringify({ path: '/vault/a.txt' }).length;
    expect(estimateTokens(msg)).toBe(Math.ceil(chars / 4));
  });

  test('toolResult text content → chars/4', () => {
    expect(estimateTokens(toolResult('a'.repeat(16)))).toBe(4);
  });
});

describe('estimateContextTokens', () => {
  test('falls back to char/4 when no assistant usage is reported', () => {
    const msgs = [user('a'.repeat(40)), user('b'.repeat(40))];
    expect(estimateContextTokens(msgs)).toBe(20);
  });

  test('prefers the most recent assistant usage + estimates trailing messages', () => {
    const msgs = [user('a'.repeat(400)), assistant('irrelevant', 1000), user('b'.repeat(40))];
    // usage 1000 + trailing 'b'.repeat(40) / 4 = 10
    expect(estimateContextTokens(msgs)).toBe(1010);
  });
});

describe('shouldCompact', () => {
  test('returns false when disabled', () => {
    expect(
      shouldCompact([user('x')], 128000, { ...DEFAULT_COMPACTION_SETTINGS, enabled: false })
    ).toBe(false);
  });

  test('triggers when tokens exceed contextWindow - reserveTokens', () => {
    const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 100, contextWindow: 1000 };
    const msgs = [assistant('x', 950)];
    expect(shouldCompact(msgs, 1000, settings)).toBe(true);
  });

  test('stays below threshold for small sessions', () => {
    expect(shouldCompact([user('hi')], 128000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
  });
});
