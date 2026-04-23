import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearHandles,
  deriveUniqueMountName,
  loadHandles,
  saveHandles,
  type VolumeHandleRecord,
} from './fsa-handle-store';

function fakeHandle(name: string): FileSystemDirectoryHandle {
  // Real FSA handles are structured-cloneable but idb-keyval uses
  // `structuredClone` which rejects functions. For the persistence
  // round-trip test we use a POJO with the shape the store inspects.
  return {
    kind: 'directory',
    name,
  } as unknown as FileSystemDirectoryHandle;
}

describe('deriveUniqueMountName', () => {
  it('returns the base name when unused', () => {
    expect(deriveUniqueMountName('wiki', [])).toBe('wiki');
    expect(deriveUniqueMountName('wiki', ['code'])).toBe('wiki');
  });

  it('appends numeric suffix on collision', () => {
    expect(deriveUniqueMountName('wiki', ['wiki'])).toBe('wiki-1');
    expect(deriveUniqueMountName('wiki', ['wiki', 'wiki-1'])).toBe('wiki-2');
    expect(deriveUniqueMountName('wiki', ['wiki', 'wiki-1', 'wiki-2'])).toBe('wiki-3');
  });

  it('sanitizes unsafe characters', () => {
    expect(deriveUniqueMountName('my docs', [])).toBe('my-docs');
    expect(deriveUniqueMountName('../evil', [])).toBe('evil');
  });

  it('falls back to "volume" for empty/blank names', () => {
    expect(deriveUniqueMountName('', [])).toBe('volume');
    expect(deriveUniqueMountName('   ', [])).toBe('volume');
  });
});

describe('fsa-handle-store persistence', () => {
  beforeEach(async () => {
    await clearHandles();
  });

  it('returns [] when nothing is stored', async () => {
    expect(await loadHandles()).toEqual([]);
  });

  it('round-trips saveHandles/loadHandles', async () => {
    const records: VolumeHandleRecord[] = [
      { handle: fakeHandle('wiki'), mountName: 'wiki', description: 'notes' },
      { handle: fakeHandle('code'), mountName: 'code' },
    ];
    await saveHandles(records);
    const loaded = await loadHandles();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].mountName).toBe('wiki');
    expect(loaded[0].description).toBe('notes');
    expect(loaded[1].mountName).toBe('code');
    expect(loaded[1].description).toBeUndefined();
  });

  it('clears the slot when saving an empty array', async () => {
    await saveHandles([{ handle: fakeHandle('wiki'), mountName: 'wiki' }]);
    await saveHandles([]);
    expect(await loadHandles()).toEqual([]);
  });
});
