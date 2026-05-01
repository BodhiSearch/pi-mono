import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { isServerEnabled, isToolEnabled, type McpToggleStore } from '@bodhiapp/web-acp-agent';
import { SessionStoreDb } from './db';
import { createMcpToggleStore } from './mcp-toggle-store';

describe('McpToggleStore (Dexie host impl)', () => {
  let db: SessionStoreDb;
  let store: McpToggleStore;

  beforeEach(() => {
    db = new SessionStoreDb(`web-acp-mcp-toggles-${crypto.randomUUID()}`);
    store = createMcpToggleStore(db);
  });

  it('returns empty snapshot for an unknown session (everything defaults on)', async () => {
    const snapshot = await store.get('session-a');
    expect(snapshot).toEqual({ servers: {}, tools: {} });
    expect(isServerEnabled(snapshot, 'everything')).toBe(true);
    expect(isToolEnabled(snapshot, 'everything', 'echo')).toBe(true);
  });

  it('persists per-server toggle overrides', async () => {
    const after = await store.setServer('session-a', 'everything', false);
    expect(after.servers).toEqual({ everything: false });
    expect(isServerEnabled(after, 'everything')).toBe(false);

    const snapshot = await store.get('session-a');
    expect(snapshot.servers.everything).toBe(false);
  });

  it('persists per-tool toggle overrides without affecting server-level flags', async () => {
    const after = await store.setTool('session-b', 'everything', 'get-sum', false);
    expect(after.tools).toEqual({ everything: { 'get-sum': false } });
    expect(after.servers).toEqual({});
    expect(isToolEnabled(after, 'everything', 'get-sum')).toBe(false);
    expect(isToolEnabled(after, 'everything', 'echo')).toBe(true);
  });

  it('server-off implies all tools off regardless of per-tool toggles', async () => {
    const withTool = await store.setTool('session-c', 'everything', 'echo', true);
    expect(isToolEnabled(withTool, 'everything', 'echo')).toBe(true);

    const withServer = await store.setServer('session-c', 'everything', false);
    expect(isServerEnabled(withServer, 'everything')).toBe(false);
    expect(isToolEnabled(withServer, 'everything', 'echo')).toBe(false);
  });

  it('independent writes do not clobber sibling entries', async () => {
    await store.setServer('session-d', 'search', true);
    await store.setTool('session-d', 'everything', 'get-sum', false);
    const snapshot = await store.get('session-d');
    expect(snapshot.servers).toEqual({ search: true });
    expect(snapshot.tools).toEqual({ everything: { 'get-sum': false } });
  });

  it('clear() drops the whole row', async () => {
    await store.setServer('session-e', 'everything', false);
    await store.setTool('session-e', 'everything', 'echo', false);
    await store.clear('session-e');
    const snapshot = await store.get('session-e');
    expect(snapshot).toEqual({ servers: {}, tools: {} });
  });

  it('set operations are additive — prior entries remain after sequential writes', async () => {
    await store.setServer('session-f', 'a', false);
    await store.setServer('session-f', 'b', true);
    await store.setTool('session-f', 'a', 'echo', false);
    const snapshot = await store.get('session-f');
    expect(snapshot.servers).toEqual({ a: false, b: true });
    expect(snapshot.tools).toEqual({ a: { echo: false } });
  });
});
