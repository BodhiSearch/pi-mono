import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, test } from 'vitest';
import type { SessionMeta, SessionSummary } from '../core/session/types';
import { RpcClient } from './rpc-client';
import { type AgentSessionHost, type HostEventSink, RpcServer } from './rpc-server';
import type { RpcSessionState } from './rpc-types';
import { createInProcessTransportPair } from './transports/in-process';

function createFakeSession(): AgentSessionHost {
  const listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  const state: {
    messages: AgentMessage[];
    isStreaming: boolean;
    streamingMessage: AgentMessage | undefined;
    errorMessage: string | undefined;
    model: unknown;
    systemPrompt: string;
  } = {
    messages: [],
    isStreaming: false,
    streamingMessage: undefined,
    errorMessage: undefined,
    model: undefined,
    systemPrompt: '',
  };

  async function emit(event: AgentEvent): Promise<void> {
    for (const listener of listeners) await listener(event);
  }

  return {
    async prompt(message: string): Promise<void> {
      state.isStreaming = true;
      await emit({ type: 'agent_start' });

      const assistant = {
        role: 'assistant',
        content: [{ type: 'text', text: `echo:${message}` }],
        api: 'openai-completions',
        provider: 'fake',
        model: 'fake-model',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      } as unknown as AgentMessage;

      state.messages.push(assistant);
      await emit({ type: 'message_end', message: assistant });
      await emit({ type: 'turn_end', message: assistant, toolResults: [] });

      state.isStreaming = false;
      await emit({ type: 'agent_end', messages: [assistant] });
    },
    abort() {
      state.isStreaming = false;
    },
    setModel(model) {
      state.model = model;
    },
    setSystemPrompt(prompt) {
      state.systemPrompt = prompt;
    },
    reset() {
      state.messages = [];
      state.streamingMessage = undefined;
      state.errorMessage = undefined;
    },
    getState(): RpcSessionState {
      return {
        isStreaming: state.isStreaming,
        messageCount: state.messages.length,
        hasModel: state.model !== undefined,
        errorMessage: state.errorMessage,
      };
    },
    getMessages: () => [...state.messages],
    isStreaming: () => state.isStreaming,
    getStreamingMessage: () => state.streamingMessage,
    getErrorMessage: () => state.errorMessage,
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}

function bootPair(): { session: AgentSessionHost; client: RpcClient } {
  const session = createFakeSession();
  const { client: clientT, server: serverT } = createInProcessTransportPair();
  new RpcServer(serverT, session);
  const client = new RpcClient(clientT);
  return { session, client };
}

describe('RPC round-trip', () => {
  test('prompt resolves after turn completes and events flow to client', async () => {
    const { client } = bootPair();

    const eventTypes: AgentEvent['type'][] = [];
    client.subscribe(envelope => {
      eventTypes.push(envelope.event.type);
    });

    await client.prompt('hi');

    expect(eventTypes).toEqual(['agent_start', 'message_end', 'turn_end', 'agent_end']);

    const messages = await client.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
  });

  test('get_state returns a serialized snapshot', async () => {
    const { client } = bootPair();

    const initial = await client.getState();
    expect(initial).toEqual({
      isStreaming: false,
      messageCount: 0,
      hasModel: false,
    });

    await client.setModel({
      id: 'test',
      api: 'openai-completions',
      provider: 'fake',
      baseUrl: '',
    } as never);

    const afterModel = await client.getState();
    expect(afterModel.hasModel).toBe(true);
  });

  test('abort and reset succeed without throwing', async () => {
    const { client } = bootPair();
    await expect(client.abort()).resolves.toBeUndefined();
    await expect(client.reset()).resolves.toBeUndefined();
  });

  test('event envelope carries messages snapshot alongside event', async () => {
    const { client } = bootPair();

    const snapshots: number[] = [];
    client.subscribe(envelope => {
      if (envelope.event.type === 'message_end') {
        snapshots.push(envelope.messages.length);
      }
    });

    await client.prompt('one');
    await client.prompt('two');

    expect(snapshots).toEqual([1, 2]);
  });
});

// ----------------------------------------------------------------------------
// M5 — session commands + session_loaded event
// ----------------------------------------------------------------------------

interface FakeSessionRecord {
  id: string;
  name?: string;
  messages: AgentMessage[];
}

function createSessionedHost(): AgentSessionHost {
  const base = createFakeSession();
  const sessions = new Map<string, FakeSessionRecord>();
  let activeId: string | null = null;
  let idCounter = 0;
  let sink: HostEventSink | null = null;

  const summary = (r: FakeSessionRecord): SessionSummary => ({
    id: r.id,
    path: `/sessions/${r.id}.jsonl`,
    name: r.name,
    cwd: '/vault',
    created: new Date(0).toISOString(),
    modified: new Date(0).toISOString(),
    messageCount: r.messages.length,
    firstMessage: '(no messages)',
  });

  const emitLoaded = () => {
    if (!sink || !activeId) return;
    const rec = sessions.get(activeId);
    if (!rec) return;
    sink({
      type: 'session_loaded',
      sessionId: rec.id,
      header: {
        type: 'session',
        id: rec.id,
        timestamp: new Date(0).toISOString(),
        cwd: '/vault',
        version: 3,
      },
      name: rec.name,
      messages: [...rec.messages],
    });
  };

  return {
    ...base,
    setHostEventSink(s) {
      sink = s;
    },
    async listSessions(): Promise<SessionSummary[]> {
      return Array.from(sessions.values()).map(summary);
    },
    async loadSession(id: string): Promise<void> {
      if (!sessions.has(id)) throw new Error(`unknown session ${id}`);
      activeId = id;
      emitLoaded();
    },
    async newSession(): Promise<{ sessionId: string }> {
      const id = `sess-${++idCounter}`;
      sessions.set(id, { id, messages: [] });
      activeId = id;
      emitLoaded();
      return { sessionId: id };
    },
    async deleteSession(id: string): Promise<void> {
      sessions.delete(id);
      if (activeId === id) activeId = null;
    },
    async setSessionName(name: string): Promise<void> {
      if (!activeId) return;
      const rec = sessions.get(activeId);
      if (rec) {
        rec.name = name;
        emitLoaded();
      }
    },
    async getSessionMeta(): Promise<SessionMeta | null> {
      if (!activeId) return null;
      const rec = sessions.get(activeId);
      if (!rec) return null;
      return { id: rec.id, path: `/sessions/${rec.id}.jsonl`, name: rec.name, cwd: '/vault' };
    },
  };
}

describe('RPC round-trip — session commands', () => {
  function bootSessionedPair() {
    const host = createSessionedHost();
    const { client: clientT, server: serverT } = createInProcessTransportPair();
    new RpcServer(serverT, host);
    const client = new RpcClient(clientT);
    return { host, client };
  }

  test('newSession returns an id and fires a session_loaded event', async () => {
    const { client } = bootSessionedPair();
    const loaded: string[] = [];
    client.onSessionLoaded(e => loaded.push(e.sessionId));
    const result = await client.newSession();
    expect(result.sessionId).toBe('sess-1');
    expect(loaded).toEqual(['sess-1']);
  });

  test('listSessions returns created sessions', async () => {
    const { client } = bootSessionedPair();
    await client.newSession();
    await client.newSession();
    const list = await client.listSessions();
    expect(list.map(s => s.id).sort()).toEqual(['sess-1', 'sess-2']);
  });

  test('setSessionName surfaces through getSessionMeta', async () => {
    const { client } = bootSessionedPair();
    await client.newSession();
    await client.setSessionName('My Session');
    const meta = await client.getSessionMeta();
    expect(meta?.name).toBe('My Session');
  });

  test('loadSession on unknown id rejects with the error message', async () => {
    const { client } = bootSessionedPair();
    await expect(client.loadSession('missing')).rejects.toThrow(/unknown session/);
  });

  test('deleteSession removes the session from listSessions', async () => {
    const { client } = bootSessionedPair();
    const { sessionId } = await client.newSession();
    await client.deleteSession(sessionId);
    const list = await client.listSessions();
    expect(list.map(s => s.id)).not.toContain(sessionId);
  });
});
