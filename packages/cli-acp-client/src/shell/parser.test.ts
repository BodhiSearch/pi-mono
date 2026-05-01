import { describe, expect, it } from 'vitest';
import { parseInputLine } from './parser';

describe('parseInputLine', () => {
  it('returns empty for whitespace', () => {
    expect(parseInputLine('').kind).toBe('empty');
    expect(parseInputLine('   ').kind).toBe('empty');
    expect(parseInputLine('/').kind).toBe('empty');
  });

  it('treats non-slash input as prompt', () => {
    expect(parseInputLine('hello world')).toEqual({ kind: 'prompt', text: 'hello world' });
  });

  it('parses simple slash commands', () => {
    expect(parseInputLine('/help')).toEqual({
      kind: 'command',
      name: 'help',
      args: [],
      raw: '/help',
    });
  });

  it('splits args on whitespace', () => {
    expect(parseInputLine('/host http://example.com')).toEqual({
      kind: 'command',
      name: 'host',
      args: ['http://example.com'],
      raw: '/host http://example.com',
    });
  });

  it('preserves quoted phrases', () => {
    const parsed = parseInputLine('/mcp add "https://example.com/mcp"');
    expect(parsed).toEqual({
      kind: 'command',
      name: 'mcp',
      args: ['add', 'https://example.com/mcp'],
      raw: '/mcp add "https://example.com/mcp"',
    });
  });

  it('handles single quotes', () => {
    expect(parseInputLine("/say 'hello world'")).toEqual({
      kind: 'command',
      name: 'say',
      args: ['hello world'],
      raw: "/say 'hello world'",
    });
  });

  it('honors backslash escapes inside quotes', () => {
    const parsed = parseInputLine('/say "hello \\"there\\""');
    expect(parsed.kind).toBe('command');
    if (parsed.kind === 'command') {
      expect(parsed.args).toEqual(['hello "there"']);
    }
  });
});
