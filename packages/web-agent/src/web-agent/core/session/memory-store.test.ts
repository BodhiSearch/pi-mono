import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, test } from 'vitest';
import { MemorySessionStore } from './memory-store';
import type { SessionStore } from './store';
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

describe('MemorySessionStore — lifecycle', () => {
  test('createSession assigns UUIDv7 id, epoch-ms timestamps, default fields', async () => {
    const store = new MemorySessionStore();
    const row = await store.createSession({ cwd: '/vault' });

    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.cwd).toBe('/vault');
    expect(row.name).toBeNull();
    expect(row.parentSession).toBeNull();
    expect(row.entryVersion).toBe(CURRENT_SESSION_VERSION);
    expect(typeof row.createdAt).toBe('number');
    expect(row.modifiedAt).toBe(row.createdAt);
  });

  test('createSession respects explicit id + parentSession', async () => {
    const store = new MemorySessionStore();
    const row = await store.createSession({
      id: 'fixed-id',
      cwd: '/vault',
      parentSession: 'parent-id',
    });
    expect(row.id).toBe('fixed-id');
    expect(row.parentSession).toBe('parent-id');
  });

  test('deleteSession removes the row + entries; missing id is a no-op', async () => {
    const store = new MemorySessionStore();
    const { id } = await store.createSession({ cwd: '/vault' });
    await store.appendMessage(id, userMessage('hi'), null);
    expect(await store.getSession(id)).not.toBeNull();
    expect(await store.getEntries(id)).toHaveLength(1);

    await store.deleteSession(id);
    expect(await store.getSession(id)).toBeNull();
    expect(await store.getEntries(id)).toHaveLength(0);

    await expect(store.deleteSession('never-existed')).resolves.toBeUndefined();
  });

  test('setSessionName appends session_info entry and updates row.name cache', async () => {
    const store = new MemorySessionStore();
    const { id } = await store.createSession({ cwd: '/vault' });
    await store.setSessionName(id, '  Big Project  ', null);

    const row = await store.getSession(id);
    expect(row?.name).toBe('Big Project');
    const entries = await store.getEntries(id);
    expect(entries).toHaveLength(1);
    const info = entries[0] as SessionInfoEntry;
    expect(info.type).toBe('session_info');
    expect(info.name).toBe('Big Project');
  });

  test('setSessionName with empty string clears the cache but still appends an entry', async () => {
    const store = new MemorySessionStore();
    const { id } = await store.createSession({ cwd: '/vault' });
    await store.setSessionName(id, 'First', null);
    await store.setSessionName(id, '   ', null);
    const row = await store.getSession(id);
    expect(row?.name).toBeNull();
    expect(await store.getEntries(id)).toHaveLength(2);
  });

  test('touchSession bumps modifiedAt on existing row; missing id is a no-op', async () => {
    const store = new MemorySessionStore();
    const row = await store.createSession({ cwd: '/vault' });
    const before = row.modifiedAt;
    await new Promise(r => setTimeout(r, 2));
    await store.touchSession(row.id);
    const after = await store.getSession(row.id);
    expect(after?.modifiedAt ?? 0).toBeGreaterThan(before);

    await expect(store.touchSession('missing')).resolves.toBeUndefined();
  });
});

describe('MemorySessionStore — list + reads', () => {
  test('listSessions sorts by modifiedAt desc; newer first', async () => {
    const store = new MemorySessionStore();
    const a = await store.createSession({ cwd: '/vault' });
    await new Promise(r => setTimeout(r, 2));
    const b = await store.createSession({ cwd: '/vault' });
    await new Promise(r => setTimeout(r, 2));
    await store.appendMessage(a.id, userMessage('bump'), null);

    const list = await store.listSessions();
    expect(list.map(s => s.id)).toEqual([a.id, b.id]);
  });

  test('listSessions returns empty on fresh store', async () => {
    const store = new MemorySessionStore();
    expect(await store.listSessions()).toEqual([]);
  });

  test('getSession returns a snapshot copy — mutating the result does not leak', async () => {
    const store = new MemorySessionStore();
    const { id } = await store.createSession({ cwd: '/vault' });
    const snap = await store.getSession(id);
    if (!snap) throw new Error('missing');
    snap.name = 'mutated';
    const again = await store.getSession(id);
    expect(again?.name).toBeNull();
  });

  test('getEntries returns empty for missing session; getEntry returns null', async () => {
    const store = new MemorySessionStore();
    expect(await store.getEntries('missing')).toEqual([]);
    expect(await store.getEntry('missing', 'nope')).toBeNull();
  });
});

describe('MemorySessionStore — appends', () => {
  test('appendMessage links via parentId, returns the new id', async () => {
    const store = new MemorySessionStore();
    const { id } = await store.createSession({ cwd: '/vault' });
    const first = await store.appendMessage(id, userMessage('a'), null);
    const second = await store.appendMessage(id, assistantMessage('b'), first);

    const entries = await store.getEntries(id);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(first);
    expect(entries[0].parentId).toBeNull();
    expect(entries[1].id).toBe(second);
    expect(entries[1].parentId).toBe(first);
  });

  test('each entry type roundtrips through the store', async () => {
    const store = new MemorySessionStore();
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

    const entries = await store.getEntries(id);
    expect(entries.map(e => e.type)).toEqual([
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

  test('append bumps modifiedAt on the session row', async () => {
    const store = new MemorySessionStore();
    const row = await store.createSession({ cwd: '/vault' });
    const before = row.modifiedAt;
    await new Promise(r => setTimeout(r, 2));
    await store.appendMessage(row.id, userMessage('hi'), null);
    const after = await store.getSession(row.id);
    expect(after?.modifiedAt ?? 0).toBeGreaterThan(before);
  });

  test('append on missing session throws', async () => {
    const store = new MemorySessionStore();
    await expect(store.appendMessage('missing', userMessage('hi'), null)).rejects.toThrow(
      /Session not found/
    );
  });

  test('appendSessionInfo updates row.name cache like setSessionName', async () => {
    const store = new MemorySessionStore();
    const { id } = await store.createSession({ cwd: '/vault' });
    await store.appendSessionInfo(id, 'Renamed via entry', null);
    const row = await store.getSession(id);
    expect(row?.name).toBe('Renamed via entry');
  });

  test('summary reflects messageCount + firstMessage + latest session_info name', async () => {
    const store = new MemorySessionStore();
    const { id } = await store.createSession({ cwd: '/vault' });
    const u1 = await store.appendMessage(id, userMessage('First user prompt'), null);
    const a1 = await store.appendMessage(id, assistantMessage('reply'), u1);
    await store.appendMessage(id, userMessage('Second user prompt'), a1);
    await store.appendSessionInfo(id, 'Named session', null);

    const [summary] = await store.listSessions();
    expect(summary.id).toBe(id);
    expect(summary.messageCount).toBe(3);
    expect(summary.firstMessage).toBe('First user prompt');
    expect(summary.name).toBe('Named session');
  });

  test('summary falls back to "(no messages)" when empty', async () => {
    const store = new MemorySessionStore();
    const { id } = await store.createSession({ cwd: '/vault' });
    const [summary] = await store.listSessions();
    expect(summary.id).toBe(id);
    expect(summary.messageCount).toBe(0);
    expect(summary.firstMessage).toBe('(no messages)');
  });
});

describe('MemorySessionStore — observers', () => {
  test('observeSessionList / observeEntries are optional (memory store omits)', () => {
    const store: SessionStore = new MemorySessionStore();
    expect(store.observeSessionList).toBeUndefined();
    expect(store.observeEntries).toBeUndefined();
  });
});
