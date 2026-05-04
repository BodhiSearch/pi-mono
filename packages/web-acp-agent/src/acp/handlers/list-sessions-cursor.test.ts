import { describe, expect, it } from 'vitest';
import { decodeCursor, DEFAULT_PER_PAGE, encodeCursor } from './list-sessions-cursor';

describe('list-sessions-cursor', () => {
  it('decodes undefined to first-page defaults', () => {
    const c = decodeCursor(undefined);
    expect(c).toEqual({
      page: 1,
      perPage: DEFAULT_PER_PAGE,
      sortBy: 'updated_at',
      sortSeq: 'desc',
    });
  });

  it('round-trips a fresh cursor', () => {
    const encoded = encodeCursor({ page: 3, perPage: 10, sortBy: 'updated_at', sortSeq: 'desc' });
    expect(decodeCursor(encoded)).toEqual({
      page: 3,
      perPage: 10,
      sortBy: 'updated_at',
      sortSeq: 'desc',
    });
  });

  it('clamps perPage to [1, 100]', () => {
    expect(
      decodeCursor(encodeCursor({ page: 1, perPage: 9999, sortBy: 'updated_at', sortSeq: 'desc' }))
        .perPage
    ).toBe(100);
    expect(
      decodeCursor(encodeCursor({ page: 1, perPage: 0, sortBy: 'updated_at', sortSeq: 'desc' }))
        .perPage
    ).toBe(1);
  });

  it('clamps page to >= 1', () => {
    expect(
      decodeCursor(encodeCursor({ page: -5, perPage: 10, sortBy: 'updated_at', sortSeq: 'desc' }))
        .page
    ).toBe(1);
  });

  it('falls back to defaults on malformed input', () => {
    expect(decodeCursor('!!!not-base64!!!')).toEqual({
      page: 1,
      perPage: DEFAULT_PER_PAGE,
      sortBy: 'updated_at',
      sortSeq: 'desc',
    });
  });
});
