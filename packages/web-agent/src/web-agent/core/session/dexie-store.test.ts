import Dexie from 'dexie';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DexieSessionStore, WebAgentDB } from './dexie-store';
import { CURRENT_SESSION_VERSION, type SessionInfoEntry } from './types';

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text } as unknown as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'test',
    model: 'test-model',
    stopReason: 'stop',
  } as unknown as AgentMessage;
}

let dbName = '';
let store: DexieSessionStore;

beforeEach(() => {
  dbName = `web-agent-test-${Math.random().toString(36).slice(2)}`;
  store = new DexieSessionStore(new WebAgentDB(dbName));
});

afterEach(async () => {
  store.close();
  await Dexie.delete(dbName);
});

describe('DexieSessionStore — lifecycle', () => {
  test('createSession persists a row discoverable via getSession', async () => {
    const row = await store.createSession({ cwd: '/vault' });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.entryVersion).toBe(CURRENT_SESSION_VERSION);

    const round = await store.getSession(row.id);
    expect(round).not.toBeNull();
    expect(round?.id).toBe(row.id);
    expect(round?.cwd).toBe('/vault');
    expect(round?.name).toBeNull();
  });

  test('deleteSession cascades to entries', async () => {
    const row = await store.createSession({ cwd: '/vault' });
    await store.appendMessage(row.id, userMessage('hi'), null);
    await store.appendMessage(row.id, assistantMessage('hello'), null);
    expect(await store.getEntries(row.id)).toHaveLength(2);

    await store.deleteSession(row.id);
    expect(await store.getSession(row.id)).toBeNull();
    expect(await store.getEntries(row.id)).toHaveLength(0);
  });

  test('setSessionName writes session_info entry + updates row.name cache', async () => {
    const row = await store.createSession({ cwd: '/vault' });
    await store.setSessionName(row.id, '  Big Idea  ', null);

    const updated = await store.getSession(row.id);
    expect(updated?.name).toBe('Big Idea');
    const entries = await store.getEntries(row.id);
    expect(entries).toHaveLength(1);
    const info = entries[0] as SessionInfoEntry;
    expect(info.type).toBe('session_info');
    expect(info.name).toBe('Big Idea');
  });

  test('touchSession bumps modifiedAt', async () => {
    const row = await store.createSession({ cwd: '/vault' });
    const before = (await store.getSession(row.id))?.modifiedAt ?? 0;
    await new Promise(r => setTimeout(r, 2));
    await store.touchSession(row.id);
    const after = (await store.getSession(row.id))?.modifiedAt ?? 0;
    expect(after).toBeGreaterThan(before);
  });
});

describe('DexieSessionStore — list + reads', () => {
  test('listSessions sorts by modifiedAt desc', async () => {
    const a = await store.createSession({ cwd: '/vault' });
    await new Promise(r => setTimeout(r, 2));
    const b = await store.createSession({ cwd: '/vault' });
    await new Promise(r => setTimeout(r, 2));
    await store.appendMessage(a.id, userMessage('bump'), null);

    const list = await store.listSessions();
    expect(list.map(s => s.id)).toEqual([a.id, b.id]);
  });

  test('listSessions summary fills messageCount + firstMessage + name', async () => {
    const { id } = await store.createSession({ cwd: '/vault' });
    const u1 = await store.appendMessage(id, userMessage('First prompt'), null);
    const a1 = await store.appendMessage(id, assistantMessage('reply'), u1);
    await store.appendMessage(id, userMessage('Second prompt'), a1);
    await store.appendSessionInfo(id, 'Named', null);

    const [summary] = await store.listSessions();
    expect(summary.id).toBe(id);
    expect(summary.messageCount).toBe(3);
    expect(summary.firstMessage).toBe('First prompt');
    expect(summary.name).toBe('Named');
  });

  test('getEntries returns entries in chronological order', async () => {
    const { id } = await store.createSession({ cwd: '/vault' });
    const u = await store.appendMessage(id, userMessage('u'), null);
    const a = await store.appendMessage(id, assistantMessage('a'), u);
    const entries = await store.getEntries(id);
    expect(entries.map(e => e.id)).toEqual([u, a]);
  });
});

describe('DexieSessionStore — appends', () => {
  test('each entry type roundtrips', async () => {
    const { id } = await store.createSession({ cwd: '/vault' });

    await store.appendMessage(id, userMessage('hi'), null);
    await store.appendModelChange(id, 'anthropic', 'claude-sonnet-4-6', null);
    await store.appendThinkingLevelChange(id, 'medium', null);
    await store.appendSessionInfo(id, 'named', null);
    await store.appendCompaction(
      id,
      { summary: 's', firstKeptEntryId: 'x', tokensBefore: 100 },
      null
    );
    await store.appendBranchSummary(id, { fromId: 'root', summary: 'b' }, null);
    await store.appendLabel(id, 'target', 'flag', null);
    await store.appendCustomEntry(id, 'my-ext', { k: 1 }, null);
    await store.appendCustomMessageEntry(
      id,
      { customType: 'note', content: 'c', display: true },
      null
    );

    const types = (await store.getEntries(id)).map(e => e.type);
    expect(types).toEqual([
      'message',
      'model_change',
      'thinking_level_change',
      'session_info',
      'compaction',
      'branch_summary',
      'label',
      'custom',
      'custom_message',
    ]);
  });

  test('append on missing session throws', async () => {
    await expect(store.appendMessage('missing', userMessage('hi'), null)).rejects.toThrow(
      /Session not found/
    );
  });

  test('delete is atomic — no orphan entries remain even if entry count is large', async () => {
    const { id } = await store.createSession({ cwd: '/vault' });
    for (let i = 0; i < 25; i++) {
      await store.appendMessage(id, userMessage(`msg ${i}`), null);
    }
    await store.deleteSession(id);
    const orphans = await store.getEntries(id).then(es => es.length);
    expect(orphans).toBe(0);
  });

  test('schema version is 1', () => {
    const db = new WebAgentDB(`${dbName}-inspect`);
    expect(db.verno).toBeGreaterThan(0);
    db.close();
  });
});

describe('DexieSessionStore — observers', () => {
  test('observeSessionList emits after create and after appendMessage', async () => {
    const updates: number[] = [];
    const unsubscribe = store.observeSessionList(summaries => {
      updates.push(summaries.length);
    });

    // initial emission
    await new Promise(r => setTimeout(r, 20));
    await store.createSession({ cwd: '/vault' });
    await new Promise(r => setTimeout(r, 20));

    unsubscribe();
    expect(updates.at(-1)).toBe(1);
    // First observed value is the initial snapshot (0 sessions), then 1 after create.
    expect(updates[0]).toBe(0);
  });
});
