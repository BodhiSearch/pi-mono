import { describe, expect, test } from 'vitest';
import { generateEntryId, generateSessionId } from './ids';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateSessionId', () => {
  test('produces a v7 UUID string with the right shape', () => {
    const id = generateSessionId();
    expect(id).toMatch(UUID_V7_PATTERN);
  });

  test('generates unique ids across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(generateSessionId());
    expect(ids.size).toBe(10_000);
  });

  test('is monotonically ordered within a tight loop (same-ms case)', () => {
    // Back-to-back calls land in the same millisecond on any modern machine.
    // The id bump ensures the sorted order matches creation order.
    const ids = Array.from({ length: 256 }, () => generateSessionId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  test('is monotonically ordered across deliberate delay', async () => {
    const first = generateSessionId();
    await new Promise(r => setTimeout(r, 2));
    const second = generateSessionId();
    expect(second > first).toBe(true);
  });
});

describe('generateEntryId', () => {
  test('produces 8-char hex ids', () => {
    const id = generateEntryId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test('respects the byId collision set', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 10; i++) taken.add(generateEntryId(taken));
    expect(taken.size).toBe(10);
  });

  test('has low collision rate across 10k samples', () => {
    const ids = new Set<string>();
    let collisions = 0;
    for (let i = 0; i < 10_000; i++) {
      const id = generateEntryId();
      if (ids.has(id)) collisions++;
      ids.add(id);
    }
    // 8 hex chars = 4.3e9 space; 10k samples collision probability is tiny.
    // Single-digit collisions are within birthday-paradox expectation; we
    // care only that the helper is not catastrophically skewed.
    expect(collisions).toBeLessThan(10);
  });
});
