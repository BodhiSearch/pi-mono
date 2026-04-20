/**
 * WorkerAgentHost — session persistence integration tests.
 *
 * These cover the M5 wiring: how the host drives its SessionManager,
 * persists message_end events, restores state on loadSession, and emits
 * the synthetic `session_loaded` event sink. The pi-agent-core Agent is
 * stubbed with a minimal fake so we can emit events deterministically
 * without driving a real stream.
 */

import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { InMemory, vfs } from '@zenfs/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentSession } from '../core/agent-session';
import type { HostEventSink } from '../rpc/rpc-server';
import type { RpcEventEnvelope } from '../rpc/rpc-types';
import { SESSIONS_MOUNT, WorkerAgentHost } from './worker-host';

const SESSIONS_STORE_NAME = 'test';

type FakeSession = {
  session: AgentSession;
  emit: (event: AgentEvent) => void;
  getMessages: () => AgentMessage[];
  restoredCalls: AgentMessage[][];
};

function makeFakeAgentSession(): FakeSession {
  const messages: AgentMessage[] = [];
  const restoredCalls: AgentMessage[][] = [];
  const listeners = new Set<(e: AgentEvent) => void | Promise<void>>();
  const fake = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    prompt: async (_m: string) => {},
    abort: () => {},
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setModel: (_m: unknown) => {},
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setSystemPrompt: (_p: string) => {},
    reset: () => {
      messages.length = 0;
    },
    getState: () => ({
      isStreaming: false,
      messageCount: messages.length,
      hasModel: false,
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setAuthToken: (_t: string | null) => {},
    getAuthToken: () => null,
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

beforeEach(() => {
  try {
    vfs.umount(SESSIONS_MOUNT);
  } catch {
    // not mounted
  }
  vfs.mount(SESSIONS_MOUNT, InMemory.create({ label: SESSIONS_STORE_NAME }));
});

afterEach(() => {
  try {
    vfs.umount(SESSIONS_MOUNT);
  } catch {
    // already gone
  }
});

describe('WorkerAgentHost session persistence', () => {
  test('newSession creates a session and emits session_loaded', async () => {
    const fake = makeFakeAgentSession();
    const host = new WorkerAgentHost(fake.session, makeFakePort());
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
      expect(loaded.header?.id).toBe(sessionId);
    }
    const meta = await host.getSessionMeta();
    expect(meta?.id).toBe(sessionId);
  });

  test('message_end events are appended to the active session', async () => {
    const fake = makeFakeAgentSession();
    const host = new WorkerAgentHost(fake.session, makeFakePort());
    const { sessionId } = await host.newSession();

    fake.emit({ type: 'message_end', message: userMessage('hello') });
    fake.emit({ type: 'message_end', message: assistantMessage('hi there') });
    // Give the SessionManager write chain a tick to flush.
    await new Promise(r => setTimeout(r, 0));

    const summaries = await host.listSessions();
    const s = summaries.find(x => x.id === sessionId);
    expect(s).toBeDefined();
    expect(s!.messageCount).toBe(2);
    expect(s!.firstMessage).toBe('hello');
  });

  test('loadSession rehydrates messages and emits session_loaded', async () => {
    // First, set up a persisted session.
    const fake1 = makeFakeAgentSession();
    const host1 = new WorkerAgentHost(fake1.session, makeFakePort());
    const { sessionId } = await host1.newSession();
    fake1.emit({ type: 'message_end', message: userMessage('q') });
    fake1.emit({ type: 'message_end', message: assistantMessage('a') });
    await new Promise(r => setTimeout(r, 0));

    // Second host simulates a fresh page load.
    const fake2 = makeFakeAgentSession();
    const host2 = new WorkerAgentHost(fake2.session, makeFakePort());
    const events: RpcEventEnvelope[] = [];
    host2.setHostEventSink(e => events.push(e));

    await host2.loadSession(sessionId);

    expect(fake2.restoredCalls.length).toBeGreaterThan(0);
    const lastRestore = fake2.restoredCalls.at(-1)!;
    expect(lastRestore).toHaveLength(2);
    expect(events.some(e => e.type === 'session_loaded')).toBe(true);
  });

  test('deleteSession removes the file and swaps to a fresh session when active', async () => {
    const fake = makeFakeAgentSession();
    const host = new WorkerAgentHost(fake.session, makeFakePort());
    const { sessionId } = await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('u') });
    fake.emit({ type: 'message_end', message: assistantMessage('a') });
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
    const fake = makeFakeAgentSession();
    const host = new WorkerAgentHost(fake.session, makeFakePort());
    await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('u') });
    fake.emit({ type: 'message_end', message: assistantMessage('a') });
    await new Promise(r => setTimeout(r, 0));

    await host.setSessionName('My Demo');
    const meta = await host.getSessionMeta();
    expect(meta?.name).toBe('My Demo');
  });

  test('listSessions is empty initially and populated after a flush', async () => {
    const fake = makeFakeAgentSession();
    const host = new WorkerAgentHost(fake.session, makeFakePort());
    expect(await host.listSessions()).toEqual([]);
    await host.newSession();
    fake.emit({ type: 'message_end', message: userMessage('hello') });
    fake.emit({ type: 'message_end', message: assistantMessage('world') });
    await new Promise(r => setTimeout(r, 0));
    const summaries = await host.listSessions();
    expect(summaries.length).toBe(1);
  });
});
