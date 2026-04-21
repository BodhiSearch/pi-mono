/**
 * WorkerAgentHost — session persistence integration tests.
 *
 * Covers how the host drives its SessionManager against a `SessionStore`,
 * persists message_end events, restores state on loadSession, and emits
 * the synthetic `session_loaded` event sink. The pi-agent-core Agent is
 * stubbed so we can emit events deterministically without driving a real
 * stream. Persistence goes through `MemorySessionStore` — parity with
 * the Dexie backend is validated by the dedicated `*-store.test.ts` pair.
 */

import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { describe, expect, test } from 'vitest';
import type { AgentSession } from '../core/agent-session';
import type { LlmAuthCredential, LlmAuthProvider } from '../llm/types';
import { MemorySessionStore } from '../core/session/memory-store';
import type { SessionStore } from '../core/session/store';
import type { HostEventSink } from '../rpc/rpc-server';
import type { RpcEventEnvelope } from '../rpc/rpc-types';
import { WorkerAgentHost } from './worker-host';

type FakeSession = {
  session: AgentSession;
  emit: (event: AgentEvent) => void;
  getMessages: () => AgentMessage[];
  restoredCalls: AgentMessage[][];
  abortCount: { current: number };
  resetCount: { current: number };
  getCurrentModel: () => Model<Api> | undefined;
};

function makeFakeAgentSession(): FakeSession {
  const messages: AgentMessage[] = [];
  const restoredCalls: AgentMessage[][] = [];
  const listeners = new Set<(e: AgentEvent) => void | Promise<void>>();
  const abortCount = { current: 0 };
  const resetCount = { current: 0 };
  let currentModel: Model<Api> | undefined;
  const fake = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    prompt: async (_m: string) => {},
    abort: () => {
      abortCount.current++;
    },
    setModel: (m: Model<Api> | undefined) => {
      currentModel = m;
    },
    getModel: () => currentModel,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setSystemPrompt: (_p: string) => {},
    reset: () => {
      messages.length = 0;
      resetCount.current++;
    },
    getState: () => ({
      isStreaming: false,
      messageCount: messages.length,
      model: currentModel,
      errorMessage: undefined,
    }),
    getMessages: () => [...messages],
    isStreaming: () => false,
    getStreamingMessage: () => undefined,
    getErrorMessage: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setTools: (_t: unknown) => {},
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setStreamFn: (_f: unknown) => {},
    restoreMessages: (msgs: AgentMessage[]) => {
      messages.splice(0, messages.length, ...msgs);
      restoredCalls.push([...msgs]);
    },
    subscribe: (handler: (e: AgentEvent) => void | Promise<void>) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  return {
    session: fake as unknown as AgentSession,
    emit: (event: AgentEvent) => {
      for (const l of listeners) void l(event);
    },
    getMessages: () => messages,
    restoredCalls,
    abortCount,
    resetCount,
    getCurrentModel: () => currentModel,
  };
}

function makeFakePort(): MessagePort {
  const channel = new MessageChannel();
  return channel.port1;
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

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text } as unknown as AgentMessage;
}

type FakeAuthProvider = LlmAuthProvider & {
  credentials: (LlmAuthCredential | null)[];
  nextAuth: { apiKey: string; headers?: Record<string, string> };
};

function makeFakeAuthProvider(): FakeAuthProvider {
  const credentials: (LlmAuthCredential | null)[] = [];
  const nextAuth = { apiKey: 'fake-key' };
  return {
    credentials,
    nextAuth,
    async getApiKeyAndHeaders() {
      return nextAuth;
    },
    setAuthToken(credential) {
      credentials.push(credential);
    },
  };
}

function makeHost(store: SessionStore = new MemorySessionStore()): {
  host: WorkerAgentHost;
  fake: FakeSession;
  store: SessionStore;
  authProvider: FakeAuthProvider;
} {
  const fake = makeFakeAgentSession();
  const authProvider = makeFakeAuthProvider();
  const host = new WorkerAgentHost(fake.session, makeFakePort(), store, authProvider);
  return { host, fake, store, authProvider };
}

describe('WorkerAgentHost auth delegation', () => {
  test('setAuthToken forwards credentials to the injected LlmAuthProvider', () => {
    const { host, authProvider } = makeHost();
    const credential: LlmAuthCredential = {
      provider: 'bodhi',
      baseUrl: 'https://example.test',
      token: 'tok-1',
    };
    host.setAuthToken(credential);
    host.setAuthToken(null);
    expect(authProvider.credentials).toEqual([credential, null]);
  });
});

describe('WorkerAgentHost session persistence', () => {
  test('newSession creates a session and emits session_loaded', async () => {
    const { host } = makeHost();
    const events: RpcEventEnvelope[] = [];
    const sink: HostEventSink = e => events.push(e);
    host.setHostEventSink(sink);

    const { sessionId } = await host.newSession();
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(events).toHaveLength(1);
    const loaded = events[0];
    expect(loaded.type).toBe('session_loaded');
    if (loaded.type === 'session_loaded') {
      expect(loaded.sessionId).toBe(sessionId);
      expect(loaded.messages).toEqual([]);
      expect(loaded.messageMeta).toEqual([]);
      expect(loaded.header?.id).toBe(sessionId);
    }
    const meta = await host.getSessionMeta();
    expect(meta?.id).toBe(sessionId);
  });

  test('message_end events are appended to the active session', async () => {
    const { host, fake } = makeHost();
    const { sessionId } = await host.newSession();

    fake.emit({ type: 'message_end', message: userMessage('hello') });
    fake.emit({ type: 'message_end', message: assistantMessage('hi there') });
    // Let the queued appendMessage promises settle.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const summaries = await host.listSessions();
    const s = summaries.find(x => x.id === sessionId);
    expect(s).toBeDefined();
    expect(s!.messageCount).toBe(2);
    expect(s!.firstMessage).toBe('hello');
  });

  test('loadSession rehydrates messages and emits session_loaded with messageMeta', async () => {
    const store = new MemorySessionStore();
    const { host: host1, fake: fake1 } = makeHost(store);
    const { sessionId } = await host1.newSession();
    fake1.emit({ type: 'message_end', message: userMessage('q') });
    fake1.emit({ type: 'message_end', message: assistantMessage('a') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const { host: host2, fake: fake2 } = makeHost(store);
    const events: RpcEventEnvelope[] = [];
    host2.setHostEventSink(e => events.push(e));

    await host2.loadSession(sessionId);

    expect(fake2.restoredCalls.length).toBeGreaterThan(0);
    const lastRestore = fake2.restoredCalls.at(-1)!;
    expect(lastRestore).toHaveLength(2);
    const loaded = events.find(e => e.type === 'session_loaded');
    expect(loaded).toBeDefined();
    if (loaded?.type === 'session_loaded') {
      expect(loaded.messageMeta).toHaveLength(2);
      expect(loaded.messageMeta[0].entryId).toBeDefined();
      expect(loaded.messageMeta[1].entryId).toBeDefined();
    }
  });

  test('deleteSession removes the session and swaps to a fresh one when active', async () => {
    const { host, fake } = makeHost();
    const { sessionId } = await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('u') });
    fake.emit({ type: 'message_end', message: assistantMessage('a') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    await host.deleteSession(sessionId);

    const summaries = await host.listSessions();
    expect(summaries.some(s => s.id === sessionId)).toBe(false);
    // Active session must have been replaced — meta.id should differ.
    const meta = await host.getSessionMeta();
    expect(meta).not.toBeNull();
    expect(meta!.id).not.toBe(sessionId);
  });

  test('setSessionName appends a session_info entry reflected in getSessionMeta', async () => {
    const { host, fake } = makeHost();
    await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('u') });
    fake.emit({ type: 'message_end', message: assistantMessage('a') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    await host.setSessionName('My Demo');
    const meta = await host.getSessionMeta();
    expect(meta?.name).toBe('My Demo');
  });

  test('listSessions is empty initially and populated after a flush', async () => {
    const { host, fake } = makeHost();
    expect(await host.listSessions()).toEqual([]);
    await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('hello') });
    fake.emit({ type: 'message_end', message: assistantMessage('world') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const summaries = await host.listSessions();
    expect(summaries.length).toBe(1);
  });
});

// ============================================================================
// M6 — fork + navigateToLeaf + abort-before-reset on loadSession
// ============================================================================

describe('WorkerAgentHost — fork', () => {
  test('forkSession copies the path into a child session and activates it', async () => {
    const store = new MemorySessionStore();
    const { host, fake } = makeHost(store);
    const { sessionId: parentId } = await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('q1') });
    fake.emit({ type: 'message_end', message: assistantMessage('a1') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // Pick the assistant entry id to fork from.
    const parentEntries = await store.getEntries(parentId);
    const forkFromId = parentEntries[1].id;

    const events: RpcEventEnvelope[] = [];
    host.setHostEventSink(e => events.push(e));

    const { sessionId: forkedId } = await host.forkSession(forkFromId);
    expect(forkedId).not.toBe(parentId);

    // Child has both parent entries copied, with parentSession pointer set.
    const childEntries = await store.getEntries(forkedId);
    expect(childEntries.map(e => e.id)).toEqual(parentEntries.map(e => e.id));
    const childRow = await store.getSession(forkedId);
    expect(childRow?.parentSession).toBe(parentId);

    // Active session swapped + session_loaded emitted.
    expect((await host.getSessionMeta())?.id).toBe(forkedId);
    const loaded = events.find(e => e.type === 'session_loaded');
    expect(loaded?.type).toBe('session_loaded');
    if (loaded?.type === 'session_loaded') {
      expect(loaded.sessionId).toBe(forkedId);
      expect(loaded.messages).toHaveLength(2);
    }
  });

  test('forkSession aborts an in-flight turn before swapping state', async () => {
    const { host, fake } = makeHost();
    const { sessionId } = await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('u') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const before = fake.abortCount.current;
    const entries = await host.listSessions();
    expect(entries.find(s => s.id === sessionId)).toBeDefined();
    // Use the last appended entry as the fork point.
    const sourceEntries = await (
      host as unknown as {
        store: MemorySessionStore;
      }
    ).store.getEntries(sessionId);
    await host.forkSession(sourceEntries[sourceEntries.length - 1].id);
    expect(fake.abortCount.current).toBeGreaterThan(before);
  });

  test('forkSession with no active session throws', async () => {
    const { host } = makeHost();
    await expect(host.forkSession('nope')).rejects.toThrow(/No active session/);
  });
});

describe('WorkerAgentHost — navigateToLeaf', () => {
  test('moves leaf in the active session and re-restores agent context', async () => {
    const store = new MemorySessionStore();
    const { host, fake } = makeHost(store);
    const { sessionId } = await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('u1') });
    fake.emit({ type: 'message_end', message: assistantMessage('a1') });
    fake.emit({ type: 'message_end', message: userMessage('u2') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const entries = await store.getEntries(sessionId);
    expect(entries).toHaveLength(3);
    const targetId = entries[1].id; // assistant message — branch point

    const restoresBefore = fake.restoredCalls.length;
    await host.navigateToLeaf(targetId);
    // restoreMessages was called again, with the truncated branch.
    expect(fake.restoredCalls.length).toBeGreaterThan(restoresBefore);
    const lastRestore = fake.restoredCalls.at(-1)!;
    expect(lastRestore).toHaveLength(2); // u1 + a1, NOT u2
  });

  test('aborts in-flight turn before restoring', async () => {
    const store = new MemorySessionStore();
    const { host, fake } = makeHost(store);
    const { sessionId } = await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('u1') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const entries = await store.getEntries(sessionId);
    const before = fake.abortCount.current;
    await host.navigateToLeaf(entries[0].id);
    expect(fake.abortCount.current).toBeGreaterThan(before);
  });

  test('navigateToLeaf with no active session throws', async () => {
    const { host } = makeHost();
    await expect(host.navigateToLeaf('nope')).rejects.toThrow(/No active session/);
  });

  test('navigateToLeaf with unknown entry throws', async () => {
    const { host } = makeHost();
    await host.newSession();
    await expect(host.navigateToLeaf('missing-entry')).rejects.toThrow(/Entry not found/);
  });
});

describe('WorkerAgentHost — deleteSession parent fallback', () => {
  test('deleting an active fork switches to the parent (not a fresh session)', async () => {
    const store = new MemorySessionStore();
    const { host, fake } = makeHost(store);
    const { sessionId: parentId } = await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('q') });
    fake.emit({ type: 'message_end', message: assistantMessage('a') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const parentEntries = await store.getEntries(parentId);
    const forkPoint = parentEntries[parentEntries.length - 1].id;
    const { sessionId: forkId } = await host.forkSession(forkPoint);
    expect((await host.getSessionMeta())?.id).toBe(forkId);

    await host.deleteSession(forkId);

    // Active session must now be the PARENT, not a fresh empty one.
    const meta = await host.getSessionMeta();
    expect(meta?.id).toBe(parentId);
    // And the parent's persisted history should be restored to the agent.
    expect(fake.restoredCalls.at(-1)?.length).toBe(2);
  });

  test('deleting an active fork whose parent has been deleted falls back to a new session', async () => {
    const store = new MemorySessionStore();
    const { host, fake } = makeHost(store);
    const { sessionId: parentId } = await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('q') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const parentEntries = await store.getEntries(parentId);
    const { sessionId: forkId } = await host.forkSession(
      parentEntries[parentEntries.length - 1].id
    );
    // Wipe the parent from the store directly to simulate it being deleted
    // earlier in the session.
    await store.deleteSession(parentId);

    await host.deleteSession(forkId);

    const meta = await host.getSessionMeta();
    expect(meta?.id).toBeDefined();
    expect(meta?.id).not.toBe(parentId);
    expect(meta?.id).not.toBe(forkId);
  });
});

// ============================================================================
// Model registry + persistence + restore
// ============================================================================

function fakeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    provider,
    api: 'openai-completions',
    baseUrl: '',
  } as unknown as Model<Api>;
}

describe('WorkerAgentHost — model registry + persistence', () => {
  test('setModel resolves via the registry and updates the session', async () => {
    const { host, fake } = makeHost();
    const oai = fakeModel('openai', 'gpt-4.1-nano');
    host.setAvailableModels([oai]);
    await host.newSession();

    const resolved = await host.setModel('openai', 'gpt-4.1-nano');
    expect(resolved).toBe(oai);
    expect(fake.getCurrentModel()).toBe(oai);
  });

  test('setModel throws when the identifier is not in the registry', async () => {
    const { host } = makeHost();
    await host.newSession();
    await expect(host.setModel('openai', 'unknown-model')).rejects.toThrow(/Model not registered/);
  });

  test('setModel persists a model_change entry; repeated setModel dedupes', async () => {
    const store = new MemorySessionStore();
    const { host } = makeHost(store);
    const oai = fakeModel('openai', 'gpt-4.1-nano');
    host.setAvailableModels([oai]);
    const { sessionId } = await host.newSession();

    await host.setModel('openai', 'gpt-4.1-nano');
    // Let the appendModelChange chain settle.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const firstEntries = await store.getEntries(sessionId);
    expect(firstEntries.filter(e => e.type === 'model_change')).toHaveLength(1);

    await host.setModel('openai', 'gpt-4.1-nano');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const secondEntries = await store.getEntries(sessionId);
    expect(secondEntries.filter(e => e.type === 'model_change')).toHaveLength(1);
  });

  test('setModel to a different identity appends a second model_change entry', async () => {
    const store = new MemorySessionStore();
    const { host } = makeHost(store);
    const oai = fakeModel('openai', 'gpt-4.1-nano');
    const gem = fakeModel('google', 'gemini-2.0-flash-lite');
    host.setAvailableModels([oai, gem]);
    const { sessionId } = await host.newSession();

    await host.setModel('openai', 'gpt-4.1-nano');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    await host.setModel('google', 'gemini-2.0-flash-lite');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const entries = await store.getEntries(sessionId);
    const modelChanges = entries.filter(
      (e): e is typeof e & { type: 'model_change'; provider: string; modelId: string } =>
        e.type === 'model_change'
    );
    expect(modelChanges).toHaveLength(2);
    expect(modelChanges[0].modelId).toBe('gpt-4.1-nano');
    expect(modelChanges[1].modelId).toBe('gemini-2.0-flash-lite');
  });

  test('loadSession restores the last model_change into the session', async () => {
    const store = new MemorySessionStore();
    const gem = fakeModel('google', 'gemini-2.0-flash-lite');

    // Host 1: record a model_change on a session.
    const { host: host1 } = makeHost(store);
    host1.setAvailableModels([gem]);
    const { sessionId } = await host1.newSession();
    await host1.setModel('google', 'gemini-2.0-flash-lite');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // Host 2: load it fresh, registry seeded — restore should apply.
    const { host: host2, fake: fake2 } = makeHost(store);
    host2.setAvailableModels([gem]);
    await host2.loadSession(sessionId);

    expect(fake2.getCurrentModel()?.id).toBe('gemini-2.0-flash-lite');
    expect(fake2.getCurrentModel()?.provider).toBe('google');
  });

  test('loadSession with empty registry leaves model undefined; late setAvailableModels retroactively applies', async () => {
    const store = new MemorySessionStore();
    const gem = fakeModel('google', 'gemini-2.0-flash-lite');

    const { host: host1 } = makeHost(store);
    host1.setAvailableModels([gem]);
    const { sessionId } = await host1.newSession();
    await host1.setModel('google', 'gemini-2.0-flash-lite');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // Host 2: load WITHOUT seeding the registry first.
    const { host: host2, fake: fake2 } = makeHost(store);
    await host2.loadSession(sessionId);
    expect(fake2.getCurrentModel()).toBeUndefined();

    // Now seed — the boot-race recovery path re-applies.
    host2.setAvailableModels([gem]);
    expect(fake2.getCurrentModel()?.id).toBe('gemini-2.0-flash-lite');
  });

  test('fork inherits the branch model; subsequent setModel on the fork does not affect the parent', async () => {
    const store = new MemorySessionStore();
    const oai = fakeModel('openai', 'gpt-4.1-nano');
    const gem = fakeModel('google', 'gemini-2.0-flash-lite');
    const { host, fake } = makeHost(store);
    host.setAvailableModels([oai, gem]);

    const { sessionId: parentId } = await host.newSession();
    await host.setModel('openai', 'gpt-4.1-nano');
    fake.emit({ type: 'message_end', message: userMessage('q1') });
    fake.emit({ type: 'message_end', message: assistantMessage('a1') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const parentEntries = await store.getEntries(parentId);
    const assistantEntry = parentEntries.find(
      e => e.type === 'message' && (e as { message: AgentMessage }).message.role === 'assistant'
    );
    if (!assistantEntry) throw new Error('no assistant entry to fork from');

    const { sessionId: forkId } = await host.forkSession(assistantEntry.id);
    // Fork inherits parent's last model_change.
    expect(fake.getCurrentModel()?.id).toBe('gpt-4.1-nano');

    await host.setModel('google', 'gemini-2.0-flash-lite');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // The fork's latest model_change is Gemini.
    const forkEntries = await store.getEntries(forkId);
    const forkModelChanges = forkEntries.filter(e => e.type === 'model_change');
    expect(
      forkModelChanges[forkModelChanges.length - 1] as unknown as { modelId: string }
    ).toMatchObject({ modelId: 'gemini-2.0-flash-lite' });

    // Parent is untouched.
    await host.loadSession(parentId);
    expect(fake.getCurrentModel()?.id).toBe('gpt-4.1-nano');
  });
});

describe('WorkerAgentHost — loadSession aborts before reset', () => {
  test('loadSession drains writeChain and aborts the agent before swapping', async () => {
    const store = new MemorySessionStore();
    const { host: host1, fake: fake1 } = makeHost(store);
    const { sessionId: a } = await host1.newSession();
    fake1.emit({ type: 'message_end', message: userMessage('u') });
    fake1.emit({ type: 'message_end', message: assistantMessage('a') });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const { host: host2, fake: fake2 } = makeHost(store);
    await host2.newSession(); // arms the host with an active session
    const before = fake2.abortCount.current;

    await host2.loadSession(a);
    expect(fake2.abortCount.current).toBeGreaterThan(before);
    // restoreMessages was called with the persisted history.
    expect(fake2.restoredCalls.at(-1)?.length).toBe(2);
  });
});
