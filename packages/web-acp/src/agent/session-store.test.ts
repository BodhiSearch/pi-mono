import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import {
  createStoreFromDb,
  deriveTitle,
  SessionStoreDb,
  type SessionStore,
  type TurnPayload,
} from './session-store';

function notification(sessionId: string, text: string, messageId?: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      ...(messageId ? { messageId } : {}),
    },
  } as SessionNotification;
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as unknown as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] } as unknown as AgentMessage;
}

describe('SessionStore', () => {
  let db: SessionStoreDb;
  let store: SessionStore;

  beforeEach(() => {
    db = new SessionStoreDb(`web-acp-test-${crypto.randomUUID()}`);
    store = createStoreFromDb(db);
  });

  afterEach(async () => {
    await db.delete();
    db.close();
  });

  it('creates a session and lists it in summaries', async () => {
    await store.createSession('s1', 1000);
    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 's1',
      title: null,
      createdAt: 1000,
      updatedAt: 1000,
      turnCount: 0,
      lastModelId: null,
    });
  });

  it('records notifications in monotonic seq order', async () => {
    await store.createSession('s1');
    await store.recordNotification('s1', notification('s1', 'hello', 'm1'));
    await store.recordNotification('s1', notification('s1', ' world', 'm1'));
    await store.recordNotification('s1', notification('s1', '!', 'm2'));

    const entries = await store.readEntries('s1');
    expect(entries.map(e => e.seq)).toEqual([0, 1, 2]);
    expect(entries.map(e => e.kind)).toEqual(['notification', 'notification', 'notification']);
    expect((entries[0].payload as SessionNotification).update.sessionUpdate).toBe(
      'agent_message_chunk'
    );
  });

  it('records a turn with user text, final messages, and modelId; derives title on first turn', async () => {
    await store.createSession('s1', 1000);
    await store.recordTurn(
      's1',
      'what day comes after monday?',
      [userMessage('what day comes after monday?'), assistantMessage('Tuesday.')],
      'oai/gpt-4.1-nano',
      1100
    );

    const entries = await store.readEntries('s1');
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('turn');
    const payload = entries[0].payload as TurnPayload;
    expect(payload.userText).toBe('what day comes after monday?');
    expect(payload.modelId).toBe('oai/gpt-4.1-nano');
    expect(payload.finalMessages).toHaveLength(2);

    const summary = (await store.listSummaries())[0];
    expect(summary.title).toBe('what day comes after monday?');
    expect(summary.turnCount).toBe(1);
    expect(summary.lastModelId).toBe('oai/gpt-4.1-nano');
    expect(summary.updatedAt).toBe(1100);
  });

  it('second turn increments turnCount, updates lastModelId, preserves title', async () => {
    await store.createSession('s1');
    await store.recordTurn(
      's1',
      'first prompt',
      [userMessage('first prompt'), assistantMessage('a')],
      'oai/gpt-4.1-nano'
    );
    await store.recordTurn(
      's1',
      'follow-up',
      [
        userMessage('first prompt'),
        assistantMessage('a'),
        userMessage('follow-up'),
        assistantMessage('b'),
      ],
      'anthropic/claude-haiku-4-5-20251001'
    );

    const summary = (await store.listSummaries())[0];
    expect(summary.turnCount).toBe(2);
    expect(summary.title).toBe('first prompt');
    expect(summary.lastModelId).toBe('anthropic/claude-haiku-4-5-20251001');
  });

  it('interleaves notifications and turns in insertion order', async () => {
    await store.createSession('s1');
    await store.recordNotification('s1', notification('s1', 'hel'));
    await store.recordNotification('s1', notification('s1', 'lo'));
    await store.recordTurn(
      's1',
      'hi',
      [userMessage('hi'), assistantMessage('hello')],
      'oai/gpt-4.1-nano'
    );
    await store.recordNotification('s1', notification('s1', 'next'));

    const entries = await store.readEntries('s1');
    expect(entries.map(e => e.kind)).toEqual([
      'notification',
      'notification',
      'turn',
      'notification',
    ]);
    expect(entries.map(e => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('listSummaries orders sessions by updatedAt desc', async () => {
    await store.createSession('old', 100);
    await store.createSession('new', 200);
    await store.recordTurn('old', 'hi', [assistantMessage('ok')], 'oai/x', 150);
    await store.recordTurn('new', 'hi', [assistantMessage('ok')], 'oai/x', 250);

    const summaries = await store.listSummaries();
    expect(summaries.map(s => s.id)).toEqual(['new', 'old']);
  });

  it('rejects writes to an unknown session', async () => {
    await expect(store.recordNotification('missing', notification('missing', 'x'))).rejects.toThrow(
      /Unknown session|unknown session/
    );
    await expect(
      store.recordTurn('missing', 'hi', [assistantMessage('x')], 'oai/x')
    ).rejects.toThrow(/Unknown session|unknown session/);
  });

  it('deletes a session and its entries atomically', async () => {
    await store.createSession('a');
    await store.createSession('b');
    await store.recordNotification('a', notification('a', 'x'));
    await store.recordNotification('b', notification('b', 'y'));

    await store.deleteSession('a');
    expect(await store.getSession('a')).toBeUndefined();
    expect(await store.readEntries('a')).toHaveLength(0);

    expect(await store.getSession('b')).toBeDefined();
    expect(await store.readEntries('b')).toHaveLength(1);
  });

  it('setTitle overrides derived title', async () => {
    await store.createSession('s1');
    await store.recordTurn('s1', 'auto title', [assistantMessage('x')], 'oai/x');
    await store.setTitle('s1', 'Custom Title');
    const summary = (await store.listSummaries())[0];
    expect(summary.title).toBe('Custom Title');
  });
});

describe('deriveTitle', () => {
  it('returns trimmed single-line text for short input', () => {
    expect(deriveTitle('hello world')).toBe('hello world');
    expect(deriveTitle('  hello   world  ')).toBe('hello world');
  });

  it('collapses whitespace', () => {
    expect(deriveTitle('line one\nline two\n\nline three')).toBe('line one line two line three');
  });

  it('truncates long input with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const t = deriveTitle(long);
    expect(t.endsWith('…')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(60);
  });
});
