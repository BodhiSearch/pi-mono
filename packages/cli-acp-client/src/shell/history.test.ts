import { describe, expect, it } from 'vitest';
import { History } from './history';

describe('History', () => {
  it('returns undefined when empty', () => {
    const h = new History();
    expect(h.previous()).toBeUndefined();
    expect(h.next()).toBeUndefined();
  });

  it('walks backwards then forwards', () => {
    const h = new History();
    h.push('one');
    h.push('two');
    h.push('three');
    expect(h.previous()).toBe('three');
    expect(h.previous()).toBe('two');
    expect(h.previous()).toBe('one');
    expect(h.previous()).toBe('one');
    expect(h.next()).toBe('two');
    expect(h.next()).toBe('three');
    expect(h.next()).toBe('');
  });

  it('dedupes consecutive duplicates', () => {
    const h = new History();
    h.push('foo');
    h.push('foo');
    h.push('bar');
    expect(h.snapshot()).toEqual(['foo', 'bar']);
  });

  it('caps at the configured size', () => {
    const h = new History(3);
    h.push('a');
    h.push('b');
    h.push('c');
    h.push('d');
    expect(h.snapshot()).toEqual(['b', 'c', 'd']);
  });
});
