import { describe, expect, test } from 'vitest';
import { walkPathToEntry } from './tree';
import type { SessionEntry } from './types';

function entry(id: string, parentId: string | null): SessionEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: id },
  } as unknown as SessionEntry;
}

describe('walkPathToEntry', () => {
  test('linear chain returns root-to-target order inclusive', () => {
    const entries: SessionEntry[] = [
      entry('a', null),
      entry('b', 'a'),
      entry('c', 'b'),
      entry('d', 'c'),
    ];
    const path = walkPathToEntry(entries, 'c');
    expect(path.map(e => e.id)).toEqual(['a', 'b', 'c']);
  });

  test('target at root returns just the root', () => {
    const entries: SessionEntry[] = [entry('a', null), entry('b', 'a')];
    const path = walkPathToEntry(entries, 'a');
    expect(path.map(e => e.id)).toEqual(['a']);
  });

  test('DAG with siblings — walk follows parentId, ignores siblings', () => {
    const entries: SessionEntry[] = [
      entry('a', null),
      entry('b', 'a'),
      entry('c', 'a'),
      entry('d', 'b'),
    ];
    expect(walkPathToEntry(entries, 'd').map(e => e.id)).toEqual(['a', 'b', 'd']);
    expect(walkPathToEntry(entries, 'c').map(e => e.id)).toEqual(['a', 'c']);
  });

  test('self-parent (id === parentId) is treated as a root', () => {
    const entries: SessionEntry[] = [entry('a', 'a'), entry('b', 'a')];
    expect(walkPathToEntry(entries, 'b').map(e => e.id)).toEqual(['a', 'b']);
  });

  test('throws on unknown target', () => {
    const entries: SessionEntry[] = [entry('a', null)];
    expect(() => walkPathToEntry(entries, 'missing')).toThrow(/Entry not found: missing/);
  });

  test('throws on dangling parentId', () => {
    const entries: SessionEntry[] = [entry('b', 'a')];
    expect(() => walkPathToEntry(entries, 'b')).toThrow(/Dangling parentId a/);
  });

  test('throws on cycle', () => {
    const entries: SessionEntry[] = [entry('a', 'b'), entry('b', 'a')];
    expect(() => walkPathToEntry(entries, 'a')).toThrow(/Cycle detected/);
  });
});
