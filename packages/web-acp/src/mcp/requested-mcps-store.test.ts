import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the idb-keyval surface with an in-memory store. jsdom doesn't
// implement IndexedDB, and we only need to verify the wrapper's
// dedup + canonicalisation logic — the underlying IDB transport is
// covered by `idb-keyval`'s own tests.
const memoryStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => memoryStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    memoryStore.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    memoryStore.delete(key);
  }),
}));

import {
  REQUESTED_MCPS_IDB_KEY,
  addRequestedMcp,
  clearRequestedMcps,
  loadRequestedMcps,
  removeRequestedMcp,
  saveRequestedMcps,
} from './requested-mcps-store';

beforeEach(() => {
  memoryStore.clear();
});

afterEach(() => {
  memoryStore.clear();
});

describe('loadRequestedMcps', () => {
  it('returns an empty list when the IDB key is missing', async () => {
    expect(await loadRequestedMcps()).toEqual([]);
  });

  it('returns the persisted list when the IDB key carries a string array', async () => {
    memoryStore.set(REQUESTED_MCPS_IDB_KEY, ['https://a.example/mcp', 'https://b.example/mcp']);
    expect(await loadRequestedMcps()).toEqual(['https://a.example/mcp', 'https://b.example/mcp']);
  });

  it('filters out non-string entries defensively', async () => {
    memoryStore.set(REQUESTED_MCPS_IDB_KEY, ['https://a.example/mcp', 42, null]);
    expect(await loadRequestedMcps()).toEqual(['https://a.example/mcp']);
  });

  it('dedupes duplicate entries while preserving order', async () => {
    memoryStore.set(REQUESTED_MCPS_IDB_KEY, [
      'https://a.example/mcp',
      'https://b.example/mcp',
      'https://a.example/mcp',
    ]);
    expect(await loadRequestedMcps()).toEqual(['https://a.example/mcp', 'https://b.example/mcp']);
  });
});

describe('saveRequestedMcps', () => {
  it('persists a non-empty list', async () => {
    await saveRequestedMcps(['https://a.example/mcp']);
    expect(memoryStore.get(REQUESTED_MCPS_IDB_KEY)).toEqual(['https://a.example/mcp']);
  });

  it('removes the IDB key when given an empty list', async () => {
    memoryStore.set(REQUESTED_MCPS_IDB_KEY, ['https://a.example/mcp']);
    await saveRequestedMcps([]);
    expect(memoryStore.has(REQUESTED_MCPS_IDB_KEY)).toBe(false);
  });

  it('dedupes before writing', async () => {
    await saveRequestedMcps(['https://a.example/mcp', 'https://a.example/mcp']);
    expect(memoryStore.get(REQUESTED_MCPS_IDB_KEY)).toEqual(['https://a.example/mcp']);
  });
});

describe('clearRequestedMcps', () => {
  it('removes the IDB key', async () => {
    memoryStore.set(REQUESTED_MCPS_IDB_KEY, ['https://a.example/mcp']);
    await clearRequestedMcps();
    expect(memoryStore.has(REQUESTED_MCPS_IDB_KEY)).toBe(false);
  });
});

describe('addRequestedMcp', () => {
  it('persists the canonical URL on a fresh add', async () => {
    const result = await addRequestedMcp('HTTPS://Mcp.Example.COM:443/path');
    expect(result).toEqual({
      list: ['https://mcp.example.com/path'],
      added: true,
      canonical: 'https://mcp.example.com/path',
    });
    expect(memoryStore.get(REQUESTED_MCPS_IDB_KEY)).toEqual(['https://mcp.example.com/path']);
  });

  it('returns added:false without re-writing when the URL is already present', async () => {
    await saveRequestedMcps(['https://mcp.example.com/path']);
    const result = await addRequestedMcp('https://mcp.example.com/path');
    expect(result.added).toBe(false);
    expect(result.list).toEqual(['https://mcp.example.com/path']);
  });

  it('returns canonical:null on parse failure and leaves the list unchanged', async () => {
    await saveRequestedMcps(['https://a.example/mcp']);
    const result = await addRequestedMcp('not-a-url');
    expect(result.canonical).toBeNull();
    expect(result.added).toBe(false);
    expect(result.list).toEqual(['https://a.example/mcp']);
  });
});

describe('removeRequestedMcp', () => {
  it('drops the canonical URL when present', async () => {
    await saveRequestedMcps(['https://a.example/mcp', 'https://b.example/mcp']);
    const result = await removeRequestedMcp('https://a.example/mcp');
    expect(result).toEqual({
      list: ['https://b.example/mcp'],
      removed: true,
      canonical: 'https://a.example/mcp',
    });
    expect(memoryStore.get(REQUESTED_MCPS_IDB_KEY)).toEqual(['https://b.example/mcp']);
  });

  it('returns removed:false when the URL is missing', async () => {
    await saveRequestedMcps(['https://a.example/mcp']);
    const result = await removeRequestedMcp('https://other.example/mcp');
    expect(result.removed).toBe(false);
    expect(result.list).toEqual(['https://a.example/mcp']);
  });

  it('returns canonical:null on parse failure', async () => {
    const result = await removeRequestedMcp('not-a-url');
    expect(result.canonical).toBeNull();
    expect(result.removed).toBe(false);
  });
});
