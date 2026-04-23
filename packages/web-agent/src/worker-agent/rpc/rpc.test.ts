import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { describe, expect, test } from 'vitest';
import type { SessionMeta, SessionSummary } from '../core/session/types';
import { RpcClient } from './rpc-client';
import { type AgentSessionHost, type HostEventSink, RpcServer } from './rpc-server';
import type {
  ExtensionUIRequestEvent,
  ExtensionUIResponseCommand,
  RpcSessionState,
} from './rpc-types';
import { createInProcessTransportPair } from './transports/in-process';

type FakeSession = AgentSessionHost & { __seedModels(models: Model<Api>[]): void };

function createFakeSession(): FakeSession {
  const listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  const state: {
    messages: AgentMessage[];
    isStreaming: boolean;
    streamingMessage: AgentMessage | undefined;
    errorMessage: string | undefined;
    model: Model<Api> | undefined;
    systemPrompt: string;
    availableModels: Model<Api>[];
  } = {
    messages: [],
    isStreaming: false,
    streamingMessage: undefined,
    errorMessage: undefined,
    model: undefined,
    systemPrompt: '',
    availableModels: [],
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
    async setModel(provider: string, modelId: string): Promise<Model<Api>> {
      const resolved = state.availableModels.find(m => m.provider === provider && m.id === modelId);
      if (!resolved) throw new Error(`Model not registered: ${provider}/${modelId}`);
      state.model = resolved;
      return resolved;
    },
    getAvailableModels(): Model<Api>[] {
      return [...state.availableModels];
    },
    // Test-only hook for seeding the fake catalog, mirroring the prior
    // setAvailableModels RPC but kept off the AgentSessionHost interface.
    __seedModels(models: Model<Api>[]): void {
      state.availableModels = [...models];
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
        model: state.model,
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

function bootPair(): { session: FakeSession; client: RpcClient } {
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
    const { session, client } = bootPair();

    const initial = await client.getState();
    expect(initial).toEqual({
      isStreaming: false,
      messageCount: 0,
    });

    const fakeModel = {
      id: 'test',
      api: 'openai-completions',
      provider: 'fake',
      baseUrl: '',
    } as unknown as Model<Api>;
    // Worker now owns catalog — seed the fake directly rather than via RPC.
    session.__seedModels([fakeModel]);
    await client.setModel('fake', 'test');

    const afterModel = await client.getState();
    expect(afterModel.model?.id).toBe('test');
    expect(afterModel.model?.provider).toBe('fake');
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
  parentSession?: string;
  messages: AgentMessage[];
}

function createSessionedHost(): AgentSessionHost {
  const base = createFakeSession();
  const sessions = new Map<string, FakeSessionRecord>();
  let activeId: string | null = null;
  let idCounter = 0;
  let sink: HostEventSink | null = null;
  let leafId: string | null = null;

  const summary = (r: FakeSessionRecord): SessionSummary => ({
    id: r.id,
    path: r.id,
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
      messageMeta: rec.messages.map((_, i) => ({ entryId: `entry-${rec.id}-${i}` })),
      model: null,
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
      return {
        id: rec.id,
        path: rec.id,
        name: rec.name,
        cwd: '/vault',
        parentSession: rec.parentSession,
      };
    },
    async forkSession(fromEntryId: string): Promise<{ sessionId: string }> {
      if (!activeId) throw new Error('No active session');
      const source = sessions.get(activeId);
      if (!source) throw new Error('Active session missing');
      const id = `sess-${++idCounter}`;
      sessions.set(id, {
        id,
        parentSession: source.id,
        messages: [...source.messages],
      });
      activeId = id;
      leafId = fromEntryId;
      emitLoaded();
      return { sessionId: id };
    },
    async navigateToLeaf(entryId: string): Promise<void> {
      leafId = entryId;
      // Reference leafId so closure tracks current value if extended later.
      void leafId;
      emitLoaded();
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

  // M6 — fork + navigate

  test('forkSession returns a new session id and fires session_loaded with parent linkage', async () => {
    const { client } = bootSessionedPair();
    const { sessionId: parentId } = await client.newSession();

    const loaded: Array<{ id: string }> = [];
    client.onSessionLoaded(e => loaded.push({ id: e.sessionId }));

    const { sessionId: forkedId } = await client.forkSession('entry-1');
    expect(forkedId).not.toBe(parentId);
    expect(loaded.map(l => l.id)).toContain(forkedId);

    const meta = await client.getSessionMeta();
    expect(meta?.id).toBe(forkedId);
    expect(meta?.parentSession).toBe(parentId);
  });

  test('forkSession with no active session rejects through the error envelope', async () => {
    const { client } = bootSessionedPair();
    await expect(client.forkSession('entry-1')).rejects.toThrow(/No active session/);
  });

  test('navigateToLeaf resolves and triggers a session_loaded event', async () => {
    const { client } = bootSessionedPair();
    await client.newSession();
    const events: string[] = [];
    client.onSessionLoaded(() => events.push('loaded'));
    await expect(client.navigateToLeaf('entry-1')).resolves.toBeUndefined();
    expect(events.length).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------------------------
// Phase 2a — extension UI channel
// ----------------------------------------------------------------------------

describe('RPC round-trip — extension UI channel', () => {
  function bootUIPair() {
    const base = createFakeSession();
    const received: ExtensionUIResponseCommand[] = [];
    let sink: HostEventSink | null = null;
    const host: AgentSessionHost = {
      ...base,
      setHostEventSink(s) {
        sink = s;
      },
      handleExtensionUIResponse(response: ExtensionUIResponseCommand) {
        received.push(response);
      },
    };
    const { client: clientT, server: serverT } = createInProcessTransportPair();
    new RpcServer(serverT, host);
    const client = new RpcClient(clientT);
    return {
      client,
      received,
      emit: (event: ExtensionUIRequestEvent) => sink?.(event),
    };
  }

  test('extension_ui_request events flow to the client listener', async () => {
    const { client, emit } = bootUIPair();
    const seen: ExtensionUIRequestEvent[] = [];
    client.onExtensionUIRequest(event => seen.push(event));

    emit({
      type: 'extension_ui_request',
      requestId: 'req-1',
      extensionPath: '/ext/a',
      kind: 'confirm',
      payload: { title: 'T', message: 'M' },
    });

    // MessageChannel delivery is asynchronous; settle queued messages.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0].requestId).toBe('req-1');
    expect(seen[0].kind).toBe('confirm');
  });

  test('sendExtensionUIResponse reaches the host with the correlation id', async () => {
    const { client, received } = bootUIPair();
    await client.sendExtensionUIResponse('req-1', { index: 0 });
    expect(received).toEqual([
      {
        type: 'extension_ui_response',
        requestId: 'req-1',
        result: { index: 0 },
        error: undefined,
      },
    ]);
  });

  test('sendExtensionUIResponse propagates errors via the error field', async () => {
    const { client, received } = bootUIPair();
    await client.sendExtensionUIResponse('req-2', undefined, 'boom');
    expect(received).toEqual([
      {
        type: 'extension_ui_response',
        requestId: 'req-2',
        result: undefined,
        error: 'boom',
      },
    ]);
  });
});

// ----------------------------------------------------------------------------
// Phase 2b — new UI kinds (setTitle / setWidget / editor / setEditorText)
// and extension_providers_changed event.
// ----------------------------------------------------------------------------

describe('RPC round-trip — Phase 2b additions', () => {
  function bootUIPair() {
    const base = createFakeSession();
    let sink: HostEventSink | null = null;
    const host: AgentSessionHost = {
      ...base,
      setHostEventSink(s) {
        sink = s;
      },
      handleExtensionUIResponse() {},
    };
    const { client: clientT, server: serverT } = createInProcessTransportPair();
    new RpcServer(serverT, host);
    const client = new RpcClient(clientT);
    return {
      client,
      emit: (event: import('./rpc-types').RpcEventEnvelope) => sink?.(event),
    };
  }

  test('setTitle / setWidget / editor / setEditorText each flow as distinct kinds', async () => {
    const { client, emit } = bootUIPair();
    const seen: ExtensionUIRequestEvent[] = [];
    client.onExtensionUIRequest(event => seen.push(event));

    const kinds: ExtensionUIRequestEvent['kind'][] = [
      'setTitle',
      'setWidget',
      'editor',
      'setEditorText',
    ];
    const payloads: Record<string, unknown> = {
      setTitle: { text: 'hello' },
      setWidget: { widgetId: 'w1', widget: { kind: 'info', props: { message: 'hi' } } },
      editor: { title: 'Edit', prefill: '', language: null, placeholder: null },
      setEditorText: { text: 'new text' },
    };
    let idx = 0;
    for (const kind of kinds) {
      emit({
        type: 'extension_ui_request',
        requestId: `req-${idx++}`,
        extensionPath: '/ext/a',
        kind,
        payload: payloads[kind] as never,
      });
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(seen.map(s => s.kind)).toEqual(kinds);
    const widgetPayload = seen[1].payload as { widget: { kind: string } };
    expect(widgetPayload.widget.kind).toBe('info');
  });

  test('extension_providers_changed event dispatches to its dedicated listener', async () => {
    const { client, emit } = bootUIPair();
    const seen: Array<{ providerId: string }> = [];
    client.onExtensionProvidersChanged(event => {
      for (const p of event.providers) seen.push({ providerId: p.providerId });
    });
    emit({
      type: 'extension_providers_changed',
      providers: [
        { providerId: 'echo', extensionPath: '/ext/a' },
        { providerId: 'fake', extensionPath: '/ext/b' },
      ],
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(seen.map(s => s.providerId)).toEqual(['echo', 'fake']);
  });
});
