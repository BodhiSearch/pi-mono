import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, test } from 'vitest';
import { MemorySessionStore } from './memory-store';
import { SessionManager } from './session-manager';
import type { SessionInfoEntry, SessionMessageEntry } from './types';

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

describe('SessionManager — factories + header', () => {
  test('create() produces a valid header with UUIDv7 id and cwd', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    const header = sm.getHeader();
    expect(header).not.toBeNull();
    expect(header?.type).toBe('session');
    expect(header?.version).toBe(3);
    expect(header?.cwd).toBe('/vault');
    expect(header?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/);
  });

  test('create() honours explicit id + parentSession', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, {
      id: 'fixed',
      cwd: '/vault',
      parentSession: 'parent',
    });
    expect(sm.getSessionId()).toBe('fixed');
    expect(sm.getHeader()?.parentSession).toBe('parent');
  });

  test('getSessionFile is undefined under store-backed SessionManager', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    expect(sm.getSessionFile()).toBeUndefined();
  });
});

describe('SessionManager — tree state', () => {
  test('leaf pointer advances to the latest appended entry', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    const id1 = await sm.appendMessage(userMessage('one'));
    expect(sm.getLeafId()).toBe(id1);
    const id2 = await sm.appendMessage(assistantMessage('two'));
    expect(sm.getLeafId()).toBe(id2);
    expect(sm.getLeafEntry()?.id).toBe(id2);
  });

  test('getBranch walks parent chain from leaf to root', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    await sm.appendMessage(userMessage('one'));
    await sm.appendMessage(assistantMessage('two'));
    await sm.appendMessage(userMessage('three'));
    const branch = sm.getBranch();
    expect(branch.map(e => (e as SessionMessageEntry).message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  test('buildSessionContext collects messages + latest model', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    await sm.appendModelChange('anthropic', 'claude-opus-4');
    await sm.appendMessage(userMessage('hi'));
    await sm.appendModelChange('openai', 'gpt-4.1');
    await sm.appendMessage(assistantMessage('hello'));
    const ctx = sm.buildSessionContext();
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.model).toEqual({ provider: 'openai', modelId: 'gpt-4.1' });
    expect(ctx.thinkingLevel).toBe('off');
  });

  test('buildSessionContext tracks thinkingLevel', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    await sm.appendThinkingLevelChange('medium');
    await sm.appendMessage(userMessage('hi'));
    expect(sm.buildSessionContext().thinkingLevel).toBe('medium');
  });

  test('getTree assembles a root list with children under their parents', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    await sm.appendMessage(userMessage('root'));
    await sm.appendMessage(assistantMessage('child'));
    const tree = sm.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
  });
});

describe('SessionManager — session info + labels', () => {
  test('appendSessionInfo + getSessionName round-trips via entries', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    await sm.appendMessage(userMessage('hi'));
    await sm.appendMessage(assistantMessage('hello'));
    await sm.appendSessionInfo('My Project Chat');
    expect(sm.getSessionName()).toBe('My Project Chat');
    const info = sm.getEntries().filter((e): e is SessionInfoEntry => e.type === 'session_info');
    expect(info).toHaveLength(1);
    expect(info[0].name).toBe('My Project Chat');
  });

  test('appendLabelChange caches label + timestamp; clearing removes them', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    const targetId = await sm.appendMessage(userMessage('target'));
    await sm.appendLabelChange(targetId, 'flag');
    expect(sm.getLabel(targetId)).toBe('flag');
    await sm.appendLabelChange(targetId, undefined);
    expect(sm.getLabel(targetId)).toBeUndefined();
  });

  test('appendLabelChange on unknown id throws', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    await expect(sm.appendLabelChange('nope', 'x')).rejects.toThrow(/not found/);
  });
});

describe('SessionManager — load round-trip', () => {
  test('load() rehydrates entries, leaf pointer, and header from the store', async () => {
    const store = new MemorySessionStore();
    const original = await SessionManager.create(store, { cwd: '/vault' });
    await original.appendMessage(userMessage('q'));
    await original.appendMessage(assistantMessage('a'));

    const reopened = await SessionManager.load(store, original.getSessionId());
    expect(reopened.getSessionId()).toBe(original.getSessionId());
    const entries = reopened.getEntries();
    expect(entries).toHaveLength(2);
    expect((entries[0] as SessionMessageEntry).message.role).toBe('user');
    expect(reopened.getLeafId()).toBe(entries[entries.length - 1].id);
  });

  test('load() throws when the session does not exist', async () => {
    const store = new MemorySessionStore();
    await expect(SessionManager.load(store, 'missing')).rejects.toThrow(/Session not found/);
  });
});

describe('SessionManager — fork', () => {
  test('fork creates a child manager rooted in the source path', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    const u1 = await sm.appendMessage(userMessage('u1'));
    const a1 = await sm.appendMessage(assistantMessage('a1'));
    await sm.appendMessage(userMessage('u2-parent-only'));

    const forked = await sm.fork(a1);
    expect(forked.getSessionId()).not.toBe(sm.getSessionId());
    expect(forked.getHeader()?.parentSession).toBe(sm.getSessionId());
    const entries = forked.getEntries();
    expect(entries.map(e => e.id)).toEqual([u1, a1]);
    // Leaf is the forked-from entry; next append will continue from there.
    expect(forked.getLeafId()).toBe(a1);
  });

  test('fork leaves the parent session untouched', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    await sm.appendMessage(userMessage('u1'));
    const a1 = await sm.appendMessage(assistantMessage('a1'));

    const before = sm.getEntries().length;
    await sm.fork(a1);
    expect(sm.getEntries().length).toBe(before);
    expect(sm.getLeafId()).toBe(a1);
    // Continue on the parent — should pick up from original leaf.
    const newId = await sm.appendMessage(userMessage('continued'));
    expect(sm.getEntry(newId)?.parentId).toBe(a1);
  });

  test('fork on unknown entry id throws', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    await expect(sm.fork('nope')).rejects.toThrow(/Entry not found/);
  });
});

describe('SessionManager — navigateToLeaf', () => {
  test('moves leaf pointer to the specified entry', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    const u1 = await sm.appendMessage(userMessage('u1'));
    await sm.appendMessage(assistantMessage('a1'));
    await sm.appendMessage(userMessage('u2'));

    sm.navigateToLeaf(u1);
    expect(sm.getLeafId()).toBe(u1);
    const sibling = await sm.appendMessage(assistantMessage('sibling'));
    expect(sm.getEntry(sibling)?.parentId).toBe(u1);

    // Branch now has: u1 → (a1 old branch), u1 → (sibling new branch).
    const branch = sm.getBranch();
    expect(branch.map(e => e.id)).toEqual([u1, sibling]);
  });

  test('throws on unknown entry id', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    expect(() => sm.navigateToLeaf('nope')).toThrow(/Entry not found/);
  });

  test('persists nothing — reload restores leaf as the chronologically-latest entry', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    const u1 = await sm.appendMessage(userMessage('u1'));
    const a1 = await sm.appendMessage(assistantMessage('a1'));
    sm.navigateToLeaf(u1);
    expect(sm.getLeafId()).toBe(u1);

    const reloaded = await SessionManager.load(store, sm.getSessionId());
    expect(reloaded.getLeafId()).toBe(a1);
  });
});

describe('SessionManager — concurrent appends', () => {
  test('serial awaits preserve insertion order in the cached entries', async () => {
    const store = new MemorySessionStore();
    const sm = await SessionManager.create(store, { cwd: '/vault' });
    await sm.appendMessage(userMessage('u1'));
    await sm.appendMessage(assistantMessage('a1'));
    await sm.appendMessage(userMessage('u2'));
    await sm.appendMessage(assistantMessage('a2'));
    await sm.appendMessage(userMessage('u3'));
    await sm.appendMessage(assistantMessage('a3'));

    const roles = sm.getEntries().map(e => (e as SessionMessageEntry).message.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  });
});
