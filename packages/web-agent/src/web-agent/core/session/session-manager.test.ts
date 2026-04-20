import { fs, InMemory, vfs } from '@zenfs/core';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseJsonl, SessionManager } from './session-manager';
import type { SessionMessageEntry, SessionInfoEntry } from './types';

const SESSIONS_DIR = '/sessions';

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

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.promises.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(path: string): Promise<unknown[]> {
  const content = (await fs.promises.readFile(path, { encoding: 'utf8' })) as string;
  return parseJsonl(content);
}

beforeEach(() => {
  try {
    vfs.umount(SESSIONS_DIR);
  } catch {
    // not mounted yet
  }
  vfs.mount(SESSIONS_DIR, InMemory.create({ label: 'test-sessions' }));
});

afterEach(() => {
  try {
    vfs.umount(SESSIONS_DIR);
  } catch {
    // already gone
  }
});

describe('SessionManager — factories + header', () => {
  test('create() produces a valid header with UUIDv7 id and cwd', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR, { cwd: '/vault' });
    const header = sm.getHeader();
    expect(header).not.toBeNull();
    expect(header?.type).toBe('session');
    expect(header?.version).toBe(3);
    expect(header?.cwd).toBe('/vault');
    expect(header?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/);
    expect(sm.getSessionFile()).toMatch(/\/sessions\/.*\.jsonl$/);
  });

  test('inMemory() has no file path and does not persist', async () => {
    const sm = SessionManager.inMemory('/vault');
    expect(sm.getSessionFile()).toBeUndefined();
    sm.appendMessage(userMessage('hi'));
    sm.appendMessage(assistantMessage('hello'));
    await sm.flush();
    // No file in /sessions from the in-memory session.
    const dir = (await fs.promises.readdir(SESSIONS_DIR)) as string[];
    expect(dir.filter(f => f.endsWith('.jsonl'))).toEqual([]);
  });
});

describe('SessionManager — lazy flush', () => {
  test('no file is written before the first assistant message', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR);
    sm.appendMessage(userMessage('hello'));
    await sm.flush();
    const path = sm.getSessionFile();
    expect(path).toBeDefined();
    expect(await fileExists(path!)).toBe(false);
  });

  test('first assistant message flushes the header + buffered entries', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR);
    sm.appendMessage(userMessage('hello'));
    sm.appendMessage(assistantMessage('world'));
    await sm.flush();
    const path = sm.getSessionFile();
    expect(await fileExists(path!)).toBe(true);
    const entries = await readJsonl(path!);
    expect(entries).toHaveLength(3); // header + user + assistant
    expect((entries[0] as { type: string }).type).toBe('session');
    expect((entries[1] as { type: string }).type).toBe('message');
    expect((entries[2] as { type: string }).type).toBe('message');
  });

  test('subsequent appends after flush add a single JSONL line', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR);
    sm.appendMessage(userMessage('hi'));
    sm.appendMessage(assistantMessage('ack'));
    await sm.flush();
    sm.appendMessage(userMessage('again'));
    await sm.flush();
    const entries = await readJsonl(sm.getSessionFile()!);
    expect(entries).toHaveLength(4);
    expect((entries[3] as SessionMessageEntry).message.role).toBe('user');
  });
});

describe('SessionManager — tree state', () => {
  test('leaf pointer advances to the latest appended entry', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR);
    const id1 = sm.appendMessage(userMessage('one'));
    expect(sm.getLeafId()).toBe(id1);
    const id2 = sm.appendMessage(assistantMessage('two'));
    expect(sm.getLeafId()).toBe(id2);
    expect(sm.getLeafEntry()?.id).toBe(id2);
  });

  test('getBranch walks parent chain from leaf to root', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR);
    sm.appendMessage(userMessage('one'));
    sm.appendMessage(assistantMessage('two'));
    sm.appendMessage(userMessage('three'));
    const branch = sm.getBranch();
    expect(branch.map(e => (e as SessionMessageEntry).message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  test('buildSessionContext collects messages + latest model', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR);
    sm.appendModelChange('anthropic', 'claude-opus-4');
    sm.appendMessage(userMessage('hi'));
    sm.appendModelChange('openai', 'gpt-4.1');
    sm.appendMessage(assistantMessage('hello'));
    const ctx = sm.buildSessionContext();
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.model).toEqual({ provider: 'openai', modelId: 'gpt-4.1' });
    expect(ctx.thinkingLevel).toBe('off');
  });
});

describe('SessionManager — session info', () => {
  test('appendSessionInfo + getSessionName round-trips via entries', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR);
    sm.appendMessage(userMessage('hi'));
    sm.appendMessage(assistantMessage('hello'));
    sm.appendSessionInfo('My Project Chat');
    expect(sm.getSessionName()).toBe('My Project Chat');
    await sm.flush();
    const entries = await readJsonl(sm.getSessionFile()!);
    const infoEntries = entries.filter(
      e => (e as { type?: string }).type === 'session_info'
    ) as SessionInfoEntry[];
    expect(infoEntries).toHaveLength(1);
    expect(infoEntries[0].name).toBe('My Project Chat');
  });
});

describe('SessionManager — open + list + delete', () => {
  test('open() round-trips header and entries', async () => {
    const original = await SessionManager.create(SESSIONS_DIR);
    original.appendMessage(userMessage('q'));
    original.appendMessage(assistantMessage('a'));
    await original.flush();
    const path = original.getSessionFile()!;

    const reopened = await SessionManager.open(SESSIONS_DIR, path);
    expect(reopened.getSessionId()).toBe(original.getSessionId());
    const entries = reopened.getEntries();
    expect(entries).toHaveLength(2);
    expect((entries[0] as SessionMessageEntry).message.role).toBe('user');
    expect(reopened.getLeafId()).not.toBeNull();
  });

  test('list() returns sessions sorted by modified desc', async () => {
    const s1 = await SessionManager.create(SESSIONS_DIR);
    s1.appendMessage(userMessage('q1'));
    s1.appendMessage(assistantMessage('a1'));
    await s1.flush();
    // Small delay so second session's mtime differs.
    await new Promise(r => setTimeout(r, 5));
    const s2 = await SessionManager.create(SESSIONS_DIR);
    s2.appendMessage(userMessage('q2'));
    s2.appendMessage(assistantMessage('a2'));
    await s2.flush();

    const summaries = await SessionManager.list(SESSIONS_DIR);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].id).toBe(s2.getSessionId());
    expect(summaries[1].id).toBe(s1.getSessionId());
    expect(summaries[0].messageCount).toBe(2);
    expect(summaries[0].firstMessage).toBe('q2');
  });

  test('list() returns empty array when directory is missing', async () => {
    const summaries = await SessionManager.list('/does-not-exist');
    expect(summaries).toEqual([]);
  });

  test('delete() removes the session file', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR);
    sm.appendMessage(userMessage('hi'));
    sm.appendMessage(assistantMessage('hello'));
    await sm.flush();
    const path = sm.getSessionFile()!;
    expect(await fileExists(path)).toBe(true);
    await SessionManager.delete(path);
    expect(await fileExists(path)).toBe(false);
  });
});

describe('SessionManager — concurrency + resilience', () => {
  test('overlapping appends land in order on disk', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR);
    sm.appendMessage(userMessage('u1'));
    // First assistant triggers lazy flush; then pile on concurrent appends.
    sm.appendMessage(assistantMessage('a1'));
    sm.appendMessage(userMessage('u2'));
    sm.appendMessage(assistantMessage('a2'));
    sm.appendMessage(userMessage('u3'));
    sm.appendMessage(assistantMessage('a3'));
    await sm.flush();
    const entries = await readJsonl(sm.getSessionFile()!);
    // 1 header + 6 messages.
    expect(entries).toHaveLength(7);
    const roles = entries.slice(1).map(e => (e as SessionMessageEntry).message.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  });

  test('open() skips malformed JSONL lines', async () => {
    const sm = await SessionManager.create(SESSIONS_DIR);
    sm.appendMessage(userMessage('good'));
    sm.appendMessage(assistantMessage('reply'));
    await sm.flush();
    const path = sm.getSessionFile()!;
    // Corrupt: inject a malformed line after the header.
    const original = (await fs.promises.readFile(path, { encoding: 'utf8' })) as string;
    const lines = original.split('\n');
    const corrupted = [lines[0], 'NOT JSON', ...lines.slice(1)].join('\n');
    await fs.promises.writeFile(path, corrupted);

    const reopened = await SessionManager.open(SESSIONS_DIR, path);
    expect(reopened.getEntries()).toHaveLength(2);
  });
});
