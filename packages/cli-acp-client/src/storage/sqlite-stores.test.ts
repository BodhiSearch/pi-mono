import { describe, expect, it } from 'vitest';
import { openAppDb } from './db';
import {
  createKvStore,
  createSqliteFeatureStore,
  createSqliteMcpToggleStore,
  createSqliteSessionStore,
} from './sqlite-stores';

function freshDb() {
  return openAppDb('/tmp/should-not-be-touched', { filename: ':memory:', inMemory: true });
}

describe('SqliteSessionStore', () => {
  it('round-trips create / record / list / delete', async () => {
    const db = freshDb();
    const store = createSqliteSessionStore(db);
    await store.createSession('s1', 100);
    await store.recordTurn(
      's1',
      'hello world',
      [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] as never,
      'model-x',
      150
    );
    await store.recordNotification(
      's1',
      { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk' } } as never,
      160
    );
    await store.recordBuiltin('s1', { command: 'info', userText: '/info', replyText: 'ok' }, 170);
    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 's1',
      title: 'hello world',
      turnCount: 1,
      lastModelId: 'model-x',
    });
    const entries = await store.readEntries('s1');
    expect(entries.map(e => e.kind)).toEqual(['turn', 'notification', 'builtin']);
    const persistedSession = await store.getSession('s1');
    expect(persistedSession?.turnCount).toBe(1);
    await store.deleteSession('s1');
    expect(await store.listSummaries()).toEqual([]);
    expect(await store.readEntries('s1')).toEqual([]);
  });

  it('deriveTitle truncates only on the first turn', async () => {
    const db = freshDb();
    const store = createSqliteSessionStore(db);
    await store.createSession('s1');
    await store.recordTurn('s1', 'first', [] as never, 'm1');
    await store.recordTurn('s1', 'second', [] as never, 'm1');
    const summaries = await store.listSummaries();
    expect(summaries[0].title).toBe('first');
  });
});

describe('SqliteFeatureStore', () => {
  it('returns defaults when nothing is set', async () => {
    const db = freshDb();
    const features = createSqliteFeatureStore(db);
    const snapshot = await features.get('s1');
    expect(snapshot.bashEnabled).toBe(true);
    expect(snapshot.forceToolCall).toBe(false);
  });

  it('merges persisted overrides on top of defaults', async () => {
    const db = freshDb();
    const features = createSqliteFeatureStore(db);
    await features.set('s1', 'bashEnabled', false);
    const snapshot = await features.get('s1');
    expect(snapshot.bashEnabled).toBe(false);
    expect(snapshot.forceToolCall).toBe(false);
  });

  it('rejects unknown feature keys', async () => {
    const db = freshDb();
    const features = createSqliteFeatureStore(db);
    await expect(features.set('s1', 'unknown', true)).rejects.toThrow(/Unknown feature/);
  });

  it('clear drops all overrides for a session', async () => {
    const db = freshDb();
    const features = createSqliteFeatureStore(db);
    await features.set('s1', 'bashEnabled', false);
    await features.clear('s1');
    expect((await features.get('s1')).bashEnabled).toBe(true);
  });
});

describe('SqliteMcpToggleStore', () => {
  it('persists per-server and per-tool toggles independently', async () => {
    const db = freshDb();
    const toggles = createSqliteMcpToggleStore(db);
    await toggles.setServer('s1', 'deepwiki', false);
    await toggles.setTool('s1', 'deepwiki', 'search', false);
    const snapshot = await toggles.get('s1');
    expect(snapshot.servers.deepwiki).toBe(false);
    expect(snapshot.tools.deepwiki?.search).toBe(false);
  });

  it('clear removes the row entirely', async () => {
    const db = freshDb();
    const toggles = createSqliteMcpToggleStore(db);
    await toggles.setServer('s1', 'deepwiki', false);
    await toggles.clear('s1');
    const snapshot = await toggles.get('s1');
    expect(snapshot.servers).toEqual({});
    expect(snapshot.tools).toEqual({});
  });
});

describe('KvStore', () => {
  it('round-trips JSON values', () => {
    const db = freshDb();
    const kv = createKvStore(db);
    kv.set('requestedMcps', ['https://a', 'https://b']);
    expect(kv.get<string[]>('requestedMcps')).toEqual(['https://a', 'https://b']);
    kv.delete('requestedMcps');
    expect(kv.get('requestedMcps')).toBeUndefined();
  });
});
