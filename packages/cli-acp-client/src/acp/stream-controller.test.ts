import type { SessionNotification } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { AcpClient, SessionUpdateListener } from './client';
import { StreamController } from './stream-controller';
import type { ShellMessage } from '../shell/types';

function fakeClient(): {
  client: AcpClient;
  emit: (notification: SessionNotification) => void;
} {
  const listeners = new Set<SessionUpdateListener>();
  const client = {
    onSessionUpdate(l: SessionUpdateListener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  } as unknown as AcpClient;
  return {
    client,
    emit(notification) {
      for (const l of listeners) l(notification);
    },
  };
}

function makeRenderer(): {
  emit: (msg: ShellMessage) => void;
  messages: ShellMessage[];
} {
  const messages: ShellMessage[] = [];
  return {
    emit(msg) {
      messages.push(msg);
    },
    messages,
  };
}

describe('StreamController', () => {
  it('subscribes to session/update on start and unsubscribes on stop', () => {
    const { client, emit } = fakeClient();
    const renderer = makeRenderer();
    const controller = new StreamController({ client, renderer });
    controller.start();
    emit({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      },
    } as SessionNotification);
    expect(controller.getState().streamingMessage).toBeDefined();
    controller.stop();
    emit({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' more' },
      },
    } as SessionNotification);
    // After stop, the controller no longer dispatches.
    expect(controller.getState().streamingMessage).toBeDefined();
  });

  it('accumulates assistant chunks under one renderer id per turn', () => {
    const { client, emit } = fakeClient();
    const renderer = makeRenderer();
    const controller = new StreamController({ client, renderer });
    controller.start();
    controller.dispatch({
      type: 'turn-start',
      userMessage: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
    emit({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } },
    } as SessionNotification);
    emit({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } },
    } as SessionNotification);
    const assistantMsgs = renderer.messages.filter(m => m.kind === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
    expect(assistantMsgs[0].id).toEqual(assistantMsgs[1].id);
    expect(assistantMsgs[1].text).toBe('Hello');
  });

  it('routes _meta.bodhi.mcp lifecycle into mcpStates and emits a status line', () => {
    const { client, emit } = fakeClient();
    const renderer = makeRenderer();
    const controller = new StreamController({ client, renderer });
    controller.start();
    emit({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
      },
      _meta: {
        bodhi: { mcp: { server: 'deepwiki', state: 'connected', tools: ['search', 'read'] } },
      },
    } as SessionNotification);
    expect(controller.getState().mcpStates.deepwiki).toEqual({
      server: 'deepwiki',
      state: 'connected',
      tools: ['search', 'read'],
    });
    expect(renderer.messages.some(m => m.kind === 'system' && m.text.includes('deepwiki'))).toBe(
      true
    );
  });

  it('dispatches builtin actions exactly once per chunk arrival', async () => {
    const { client, emit } = fakeClient();
    const renderer = makeRenderer();
    const dispatchBuiltinAction = vi.fn();
    const controller = new StreamController({
      client,
      renderer,
      dispatchBuiltinAction,
      getSessionId: () => 's1',
    });
    controller.start();
    controller.dispatch({
      type: 'turn-start',
      userMessage: { role: 'user', content: [{ type: 'text', text: '/copy' }] },
    });
    const meta = { bodhi: { builtin: { command: 'copy', action: { kind: 'copy' } } } };
    emit({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Copied conversation to clipboard.' },
      },
      _meta: meta,
    } as SessionNotification);
    emit({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
      },
      _meta: meta,
    } as SessionNotification);
    expect(dispatchBuiltinAction).toHaveBeenCalledTimes(1);
    expect(dispatchBuiltinAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { kind: 'copy' },
        sessionId: 's1',
      })
    );
  });

  it('suppresses live chunks during replay (load-start/load-end)', () => {
    const { client, emit } = fakeClient();
    const renderer = makeRenderer();
    const controller = new StreamController({ client, renderer });
    controller.start();
    controller.dispatch({ type: 'load-start' });
    emit({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ghost' } },
    } as SessionNotification);
    expect(renderer.messages.filter(m => m.kind === 'assistant')).toHaveLength(0);
    controller.dispatch({
      type: 'load-end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'restored' }] }],
    });
    expect(controller.getState().messages).toHaveLength(1);
  });

  it('updates availableCommands on available_commands_update', () => {
    const { client, emit } = fakeClient();
    const renderer = makeRenderer();
    const controller = new StreamController({ client, renderer });
    controller.start();
    emit({
      sessionId: 's1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'wiki:greet', description: 'greet' },
          { name: 'info', description: 'session info' },
        ],
      },
    } as SessionNotification);
    expect(controller.getState().availableCommands.map(c => c.name)).toEqual([
      'wiki:greet',
      'info',
    ]);
  });
});
