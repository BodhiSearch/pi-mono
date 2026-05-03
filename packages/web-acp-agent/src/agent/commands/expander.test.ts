import { describe, expect, it } from 'vitest';
import { expandCommand, tokenizeBash } from './expander';
import type { CommandDef } from './types';

function cmd(name: string, template: string, argumentHint?: string): CommandDef {
  return {
    name,
    description: 'test command',
    template,
    source: { mountName: name.split(':')[0], relPath: '.pi/commands/x.md' },
    ...(argumentHint ? { argumentHint } : {}),
  };
}

describe('tokenizeBash', () => {
  it('splits on whitespace by default', () => {
    expect(tokenizeBash('a b c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps double-quoted spans together', () => {
    expect(tokenizeBash('"alice b" charlie')).toEqual(['alice b', 'charlie']);
  });

  it('keeps single-quoted spans verbatim', () => {
    expect(tokenizeBash("'alice $1' charlie")).toEqual(['alice $1', 'charlie']);
  });

  it('honours backslash escapes outside of quotes', () => {
    expect(tokenizeBash('a\\ b c')).toEqual(['a b', 'c']);
  });

  it('honours \\" inside double quotes', () => {
    expect(tokenizeBash('"a \\"b\\" c"')).toEqual(['a "b" c']);
  });

  it('treats empty input as no tokens', () => {
    expect(tokenizeBash('')).toEqual([]);
    expect(tokenizeBash('   \t\n')).toEqual([]);
  });

  it('produces an empty token from empty quotes', () => {
    expect(tokenizeBash('""')).toEqual(['']);
    expect(tokenizeBash("''")).toEqual(['']);
  });
});

describe('expandCommand', () => {
  const commands = [
    cmd('wiki:greet', 'Hello $1, welcome to $2!'),
    cmd('wiki:echo', 'You said: $@'),
    cmd('wiki:report', 'Args = $ARGUMENTS\nPosition 1 = $1'),
  ];

  it('returns matched:false when text has no leading slash', () => {
    expect(expandCommand('hello there', commands)).toEqual({ matched: false });
  });

  it('returns matched:false for an unknown command', () => {
    expect(expandCommand('/nope arg1', commands)).toEqual({ matched: false });
  });

  it('substitutes $1 and $2 for positional args', () => {
    const r = expandCommand('/wiki:greet alice paris', commands);
    expect(r.matched).toBe(true);
    expect(r.expanded).toBe('Hello alice, welcome to paris!');
    expect(r.commandName).toBe('wiki:greet');
  });

  it('substitutes $@ with the raw argument string', () => {
    const r = expandCommand('/wiki:echo one two three', commands);
    expect(r.expanded).toBe('You said: one two three');
  });

  it('aliases $ARGUMENTS to the same raw arg string', () => {
    const r = expandCommand('/wiki:report alice bob', commands);
    expect(r.expanded).toBe('Args = alice bob\nPosition 1 = alice');
  });

  it('keeps quoted args together for $1/$2', () => {
    const r = expandCommand('/wiki:greet "alice m" "paris fr"', commands);
    expect(r.expanded).toBe('Hello alice m, welcome to paris fr!');
  });

  it('leaves unmatched positional placeholders literal', () => {
    const r = expandCommand('/wiki:greet alice', commands);
    expect(r.expanded).toBe('Hello alice, welcome to $2!');
  });

  it('leaves the literal text alone when no args are passed', () => {
    const r = expandCommand('/wiki:echo', commands);
    expect(r.expanded).toBe('You said: ');
  });

  it('matches the command name greedily up to the first whitespace', () => {
    const r = expandCommand('/wiki:greet  alice  paris', commands);
    expect(r.matched).toBe(true);
    expect(r.expanded).toBe('Hello alice, welcome to paris!');
  });

  it('does not match a bare /', () => {
    expect(expandCommand('/', commands)).toEqual({ matched: false });
  });
});
