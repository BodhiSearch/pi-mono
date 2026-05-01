import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSettingsStore } from './store';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-acp-settings-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('returns defaults when settings.json is missing', async () => {
    const store = createSettingsStore(tmpDir);
    const settings = await store.load();
    expect(settings).toEqual({ requestedMcps: [] });
  });

  it('round-trips fields through save + load', async () => {
    const store = createSettingsStore(tmpDir);
    await store.save({
      host: 'http://localhost:1135',
      authServerUrl: 'https://main-id.getbodhi.app/realms/bodhi',
      tokens: {
        accessToken: 'access',
        refreshToken: 'refresh',
        tokenType: 'Bearer',
        expiresAt: 1_700_000_000_000,
      },
      lastModelId: 'foo/bar',
      requestedMcps: ['https://example.com/mcp'],
    });
    const loaded = await store.load();
    expect(loaded.host).toBe('http://localhost:1135');
    expect(loaded.tokens?.accessToken).toBe('access');
    expect(loaded.lastModelId).toBe('foo/bar');
    expect(loaded.requestedMcps).toEqual(['https://example.com/mcp']);
  });

  it('patch merges into existing settings', async () => {
    const store = createSettingsStore(tmpDir);
    await store.save({ host: 'http://a', requestedMcps: [] });
    const next = await store.patch({ lastModelId: 'm1' });
    expect(next.host).toBe('http://a');
    expect(next.lastModelId).toBe('m1');
  });

  it('clear removes the file', async () => {
    const store = createSettingsStore(tmpDir);
    await store.save({ host: 'http://a', requestedMcps: [] });
    await store.clear();
    const loaded = await store.load();
    expect(loaded).toEqual({ requestedMcps: [] });
  });

  it('rejects malformed settings.json', async () => {
    const store = createSettingsStore(tmpDir);
    await fs.mkdir(path.join(tmpDir, '.cli-acp-client'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.cli-acp-client', 'settings.json'),
      JSON.stringify({ host: 'not a url', requestedMcps: 'oops' })
    );
    await expect(store.load()).rejects.toThrow(/Invalid settings\.json/);
  });
});
