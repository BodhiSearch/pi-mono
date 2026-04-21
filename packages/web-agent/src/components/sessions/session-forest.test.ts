import { describe, expect, test } from 'vitest';
import type { SessionSummary } from '@/worker-agent';
import { buildSessionForest } from './session-forest';

function summary(
  id: string,
  parent?: string,
  modifiedAt = '2026-04-20T00:00:00.000Z'
): SessionSummary {
  return {
    id,
    path: id,
    cwd: '/vault',
    created: modifiedAt,
    modified: modifiedAt,
    messageCount: 0,
    firstMessage: '(no messages)',
    parentSessionPath: parent,
  };
}

describe('buildSessionForest — flat-under-root semantics', () => {
  test('empty input → empty forest', () => {
    expect(buildSessionForest([])).toEqual([]);
  });

  test('single root → depth 0', () => {
    const out = buildSessionForest([summary('a')]);
    expect(out.map(n => [n.summary.id, n.depth])).toEqual([['a', 0]]);
  });

  test('single-level fork → root at 0, child at 1', () => {
    const list = [summary('R'), summary('A', 'R')];
    expect(buildSessionForest(list).map(n => [n.summary.id, n.depth])).toEqual([
      ['R', 0],
      ['A', 1],
    ]);
  });

  test('fork-of-fork (R → A → B) — both A and B render at depth 1 under R', () => {
    const list = [summary('R'), summary('A', 'R'), summary('B', 'A')];
    expect(buildSessionForest(list).map(n => [n.summary.id, n.depth])).toEqual([
      ['R', 0],
      ['A', 1],
      ['B', 1], // grand-fork sits at the same level as direct fork
    ]);
  });

  test('three-level chain (R → A → B → C) — all descendants flatten to depth 1', () => {
    const list = [summary('R'), summary('A', 'R'), summary('B', 'A'), summary('C', 'B')];
    expect(buildSessionForest(list).map(n => [n.summary.id, n.depth])).toEqual([
      ['R', 0],
      ['A', 1],
      ['B', 1],
      ['C', 1],
    ]);
  });

  test('siblings under same parent preserve insertion order', () => {
    const list = [summary('R'), summary('A1', 'R'), summary('A2', 'R'), summary('A3', 'R')];
    expect(buildSessionForest(list).map(n => n.summary.id)).toEqual(['R', 'A1', 'A2', 'A3']);
  });

  test('multiple roots each with their own descendants', () => {
    const list = [
      summary('R1'),
      summary('A', 'R1'),
      summary('R2'),
      summary('B', 'R2'),
      summary('C', 'B'), // grand-fork of R2
    ];
    expect(buildSessionForest(list).map(n => [n.summary.id, n.depth])).toEqual([
      ['R1', 0],
      ['A', 1],
      ['R2', 0],
      ['B', 1],
      ['C', 1],
    ]);
  });

  test('orphan (parent missing from input) is treated as a root', () => {
    const list = [summary('R'), summary('B', 'A')]; // B claims A as parent, A is gone
    expect(buildSessionForest(list).map(n => [n.summary.id, n.depth])).toEqual([
      ['R', 0],
      ['B', 0],
    ]);
  });

  test('cycle guard — self-referential parent is rendered once at depth 0', () => {
    const list = [summary('A', 'A')];
    const out = buildSessionForest(list);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ summary: summary('A', 'A'), depth: 0 });
  });

  test('cycle guard — A → B → A loop renders both rows without infinite walk', () => {
    const list = [summary('A', 'B'), summary('B', 'A')];
    const ids = buildSessionForest(list).map(n => n.summary.id);
    expect(new Set(ids)).toEqual(new Set(['A', 'B']));
  });
});
