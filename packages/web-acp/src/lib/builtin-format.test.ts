import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, it } from 'vitest';
import {
  extractBuiltinMeta,
  getBuiltinTag,
  renderConversationMarkdown,
  withBuiltinTag,
} from './builtin-format';

function userMsg(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as unknown as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] } as unknown as AgentMessage;
}

describe('extractBuiltinMeta', () => {
  it('returns the tag for well-formed _meta', () => {
    const tag = extractBuiltinMeta({ bodhi: { builtin: { command: 'help' } } });
    expect(tag).toEqual({ command: 'help' });
  });

  it('ignores `action` on the chunk meta — actions ride extNotification', () => {
    const tag = extractBuiltinMeta({
      bodhi: { builtin: { command: 'copy', action: { kind: 'copy' } } },
    });
    expect(tag).toEqual({ command: 'copy' });
  });

  it('returns undefined for unrelated _meta', () => {
    expect(extractBuiltinMeta(undefined)).toBeUndefined();
    expect(extractBuiltinMeta({})).toBeUndefined();
    expect(extractBuiltinMeta({ bodhi: {} })).toBeUndefined();
    expect(
      extractBuiltinMeta({ bodhi: { mcp: { server: 'x', state: 'connected' } } })
    ).toBeUndefined();
  });

  it('drops malformed action fields', () => {
    const tag = extractBuiltinMeta({
      bodhi: { builtin: { command: 'copy', action: { kind: 42 } } },
    });
    expect(tag).toEqual({ command: 'copy' });
  });
});

describe('withBuiltinTag / getBuiltinTag', () => {
  it('round-trips a tag through a message', () => {
    const tagged = withBuiltinTag(assistantMsg('hi'), { command: 'help' });
    expect(getBuiltinTag(tagged)).toEqual({ command: 'help' });
  });

  it('returns undefined on plain messages', () => {
    expect(getBuiltinTag(assistantMsg('plain'))).toBeUndefined();
  });
});

describe('renderConversationMarkdown', () => {
  it('renders user/assistant pairs as a markdown transcript', () => {
    const md = renderConversationMarkdown([
      userMsg('hi there'),
      assistantMsg('hello!'),
      userMsg('bye'),
      assistantMsg('cya'),
    ]);
    expect(md).toContain('**You:**');
    expect(md).toContain('**Assistant:**');
    expect(md).toContain('hi there');
    expect(md).toContain('cya');
  });

  it('drops messages tagged as built-in', () => {
    const md = renderConversationMarkdown([
      withBuiltinTag(userMsg('/help'), { command: 'help' }),
      withBuiltinTag(assistantMsg('help reply'), { command: 'help' }),
      userMsg('real q'),
      assistantMsg('real a'),
    ]);
    expect(md).not.toContain('/help');
    expect(md).not.toContain('help reply');
    expect(md).toContain('real q');
    expect(md).toContain('real a');
  });

  it('returns empty string when no conversational text exists', () => {
    expect(renderConversationMarkdown([])).toBe('');
    expect(renderConversationMarkdown([userMsg('   '), assistantMsg('')])).toBe('');
  });
});
