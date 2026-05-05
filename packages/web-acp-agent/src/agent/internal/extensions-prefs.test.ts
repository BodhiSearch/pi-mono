import { describe, expect, it } from 'vitest';
import type { PreferenceStore } from '../../storage/preference-store';
import {
  EXTENSIONS_DISABLED_KEY,
  EXTENSIONS_DISABLED_SCOPE,
  readDisabledExtensions,
  writeDisabledExtensions,
} from './extensions-prefs';

function inMemoryPrefs(): PreferenceStore & { dump(): Record<string, Record<string, unknown>> } {
  const data = new Map<string, Map<string, unknown>>();
  const get = (sessionId: string, key: string) => data.get(sessionId)?.get(key);
  return {
    async get(sessionId, key) {
      return get(sessionId, key);
    },
    async set(sessionId, key, value) {
      let row = data.get(sessionId);
      if (!row) {
        row = new Map();
        data.set(sessionId, row);
      }
      row.set(key, value);
    },
    async delete(sessionId, key) {
      data.get(sessionId)?.delete(key);
    },
    async list(sessionId) {
      const row = data.get(sessionId);
      if (!row) return {};
      return Object.fromEntries(row);
    },
    async clearSession(sessionId) {
      data.delete(sessionId);
    },
    dump() {
      const out: Record<string, Record<string, unknown>> = {};
      for (const [sessionId, row] of data) out[sessionId] = Object.fromEntries(row);
      return out;
    },
  };
}

describe('extensions-prefs', () => {
  it('returns an empty list when nothing is persisted', async () => {
    const prefs = inMemoryPrefs();
    expect(await readDisabledExtensions(prefs)).toEqual([]);
  });

  it('writes against the global sentinel scope and round-trips', async () => {
    const prefs = inMemoryPrefs();
    await writeDisabledExtensions(prefs, ['pirate', 'session-counter']);
    expect(prefs.dump()[EXTENSIONS_DISABLED_SCOPE]?.[EXTENSIONS_DISABLED_KEY]).toEqual([
      'pirate',
      'session-counter',
    ]);
    expect(await readDisabledExtensions(prefs)).toEqual(['pirate', 'session-counter']);
  });

  it('dedups input on write', async () => {
    const prefs = inMemoryPrefs();
    await writeDisabledExtensions(prefs, ['pirate', 'pirate', 'hello-tool']);
    expect(await readDisabledExtensions(prefs)).toEqual(['pirate', 'hello-tool']);
  });

  it('skips non-string entries when reading malformed values', async () => {
    const prefs = inMemoryPrefs();
    await prefs.set(EXTENSIONS_DISABLED_SCOPE, EXTENSIONS_DISABLED_KEY, [
      'pirate',
      42,
      null,
      'hello-tool',
    ]);
    expect(await readDisabledExtensions(prefs)).toEqual(['pirate', 'hello-tool']);
  });

  it('returns [] when the persisted value is not an array', async () => {
    const prefs = inMemoryPrefs();
    await prefs.set(EXTENSIONS_DISABLED_SCOPE, EXTENSIONS_DISABLED_KEY, 'not-an-array');
    expect(await readDisabledExtensions(prefs)).toEqual([]);
  });
});
