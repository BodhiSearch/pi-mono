import { describe, expect, it, vi } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { initialStreamingState, streamingReducer, type StreamingState } from './streaming-reducer';

function makeMsg(role: 'user' | 'assistant', text: string): AgentMessage {
  return {
    role,
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

function chunk(
  text: string,
  opts: { messageId?: string; meta?: unknown } = {}
): SessionNotification {
  return {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      ...(opts.messageId ? { messageId: opts.messageId } : {}),
    },
    ...(opts.meta ? { _meta: opts.meta } : {}),
  } as SessionNotification;
}

function toolCall(toolCallId: string, title: string): SessionNotification {
  return {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      status: 'in_progress',
    },
  } as SessionNotification;
}

function toolUpdate(
  toolCallId: string,
  status: 'completed' | 'failed' | 'in_progress',
  rawOutput?: unknown
): SessionNotification {
  return {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status,
      ...(rawOutput !== undefined ? { rawOutput } : {}),
    },
  } as SessionNotification;
}

describe('streamingReducer', () => {
  it('appends a user message and clears streaming on turn-start', () => {
    const userMessage = makeMsg('user', 'hi');
    const next = streamingReducer(initialStreamingState, { type: 'turn-start', userMessage });
    expect(next.messages).toEqual([userMessage]);
    expect(next.streamingMessage).toBeUndefined();
    expect(next.streamingMessageId).toBeUndefined();
    expect(next.isStreaming).toBe(true);
  });

  it('accumulates agent_message_chunk text deltas', () => {
    const s1 = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: chunk('Hel', { messageId: 'm-1' }),
    });
    const s2 = streamingReducer(s1, {
      type: 'session-update',
      notif: chunk('lo', { messageId: 'm-1' }),
    });
    expect(s2.streamingMessage).toBeDefined();
    const content = (s2.streamingMessage as unknown as { content: Array<{ text: string }> })
      .content;
    expect(content[0].text).toBe('Hello');
    expect(s2.streamingMessageId).toBe('m-1');
  });

  it('starts a fresh streaming bubble when messageId changes', () => {
    let s: StreamingState = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: chunk('first', { messageId: 'm-1' }),
    });
    s = streamingReducer(s, {
      type: 'session-update',
      notif: chunk('second', { messageId: 'm-2' }),
    });
    const content = (s.streamingMessage as unknown as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toBe('second');
    expect(s.streamingMessageId).toBe('m-2');
  });

  it('carries _meta.bodhi.builtin tag onto the streaming message', () => {
    const meta = { bodhi: { builtin: { command: 'help' } } };
    const s = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: chunk('Help is...', { messageId: 'm-1', meta }),
    });
    const tag = (s.streamingMessage as unknown as { _builtin?: unknown })._builtin;
    expect(tag).toEqual({ command: 'help' });
  });

  it('replay guard suppresses live chunks', () => {
    const replaying = streamingReducer(initialStreamingState, { type: 'load-start' });
    expect(replaying.isReplaying).toBe(true);

    const blocked = streamingReducer(replaying, {
      type: 'session-update',
      notif: chunk('should not render', { messageId: 'm-1' }),
    });
    expect(blocked.streamingMessage).toBeUndefined();
  });

  it('appends tool_call view and merges tool_call_update', () => {
    let s: StreamingState = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: toolCall('t-1', 'bash:ls'),
    });
    expect(s.toolCalls.get('t-1')?.status).toBe('in_progress');
    expect(s.toolCalls.get('t-1')?.toolName).toBe('bash');
    expect(s.toolCalls.get('t-1')?.turn).toBe(0);

    s = streamingReducer(s, {
      type: 'session-update',
      notif: toolUpdate('t-1', 'completed', { result: 'ok' }),
    });
    expect(s.toolCalls.get('t-1')?.status).toBe('completed');
    expect(s.toolCalls.get('t-1')?.rawOutput).toEqual({ result: 'ok' });
  });

  it('ignores tool_call_update when no matching tool_call has been seen', () => {
    const s = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: toolUpdate('missing', 'completed'),
    });
    expect(s.toolCalls.size).toBe(0);
  });

  it('appends streamingMessage on turn-end and bumps turnIndex', () => {
    const userMessage = makeMsg('user', 'hi');
    let s: StreamingState = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage,
    });
    s = streamingReducer(s, {
      type: 'session-update',
      notif: chunk('hel', { messageId: 'm-1' }),
    });
    s = streamingReducer(s, {
      type: 'session-update',
      notif: chunk('lo', { messageId: 'm-1' }),
    });
    s = streamingReducer(s, { type: 'turn-end', stopReason: 'end_turn' });
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toEqual(userMessage);
    const reply = s.messages[1] as unknown as { content: Array<{ text: string }> };
    expect(reply.content[0].text).toBe('hello');
    expect(s.streamingMessage).toBeUndefined();
    expect(s.isStreaming).toBe(false);
    expect(s.turnIndex).toBe(1);
  });

  it('drops the streaming bubble on turn-end when stopReason is cancelled', () => {
    const userMessage = makeMsg('user', 'hi');
    let s: StreamingState = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage,
    });
    s = streamingReducer(s, {
      type: 'session-update',
      notif: chunk('partial', { messageId: 'm-1' }),
    });
    s = streamingReducer(s, { type: 'turn-end', stopReason: 'cancelled' });
    expect(s.messages).toEqual([userMessage]);
    expect(s.streamingMessage).toBeUndefined();
    expect(s.turnIndex).toBe(1);
  });

  it('turn-end without any streamingMessage leaves messages unchanged', () => {
    const userMessage = makeMsg('user', 'hi');
    let s: StreamingState = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage,
    });
    s = streamingReducer(s, { type: 'turn-end', stopReason: 'end_turn' });
    expect(s.messages).toEqual([userMessage]);
    expect(s.streamingMessage).toBeUndefined();
    expect(s.turnIndex).toBe(1);
  });

  it('load-end with messages payload replaces transcript and clears tools/turn', () => {
    let s: StreamingState = {
      ...initialStreamingState,
      messages: [makeMsg('user', 'old')],
      toolCalls: new Map([['t-1', { toolCallId: 't-1' } as unknown as never]]),
      turnIndex: 7,
    };
    s = streamingReducer(s, { type: 'load-start' });
    s = streamingReducer(s, {
      type: 'load-end',
      messages: [makeMsg('user', 'new')],
    });
    expect(s.messages).toHaveLength(1);
    expect(s.toolCalls.size).toBe(0);
    expect(s.turnIndex).toBe(0);
    expect(s.isReplaying).toBe(false);
  });

  it('load-end without messages just clears the replay flag', () => {
    let s: StreamingState = streamingReducer(initialStreamingState, { type: 'load-start' });
    s = streamingReducer(s, { type: 'load-end' });
    expect(s.isReplaying).toBe(false);
    expect(s.messages).toEqual([]);
  });

  it('reset returns to a fresh state', () => {
    const userMessage = makeMsg('user', 'hi');
    let s: StreamingState = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage,
    });
    s = streamingReducer(s, { type: 'reset' });
    expect(s.messages).toEqual([]);
    expect(s.isStreaming).toBe(false);
    expect(s.turnIndex).toBe(0);
    expect(s.toolCalls.size).toBe(0);
  });

  it.each([
    'user_message_chunk',
    'agent_thought_chunk',
    'plan',
    'current_mode_update',
    'session_info_update',
    'usage_update',
  ])('%s is a no-op (explicit case, no warn)', kind => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notif = { sessionId: 'sess-1', update: { sessionUpdate: kind } } as SessionNotification;
    const s = streamingReducer(initialStreamingState, { type: 'session-update', notif });
    expect(s).toBe(initialStreamingState);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('panel-only session-update kinds are no-ops on the streaming reducer', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cmdNotif = {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'help', description: '/help' }],
      },
    } as unknown as SessionNotification;
    const optNotif = {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'config_option_update', configOptions: [] },
    } as unknown as SessionNotification;
    const s1 = streamingReducer(initialStreamingState, { type: 'session-update', notif: cmdNotif });
    const s2 = streamingReducer(initialStreamingState, { type: 'session-update', notif: optNotif });
    expect(s1).toBe(initialStreamingState);
    expect(s2).toBe(initialStreamingState);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it.each([
    {
      action: { type: 'config-options-init', configOptions: [] } as const,
      label: 'config-options-init',
    },
    {
      action: {
        type: 'mcp-state',
        meta: { server: 'srv-1', state: 'connected' },
      } as const,
      label: 'mcp-state',
    },
  ])('panel-only action $label is a no-op on the streaming reducer', ({ action }) => {
    const s = streamingReducer(initialStreamingState, action);
    expect(s).toBe(initialStreamingState);
  });

  it('accepts pending → in_progress → completed tool-call lifecycle', () => {
    let s: StreamingState = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'bash',
          status: 'pending',
        },
      } as unknown as SessionNotification,
    });
    expect(s.toolCalls.get('tc-1')?.status).toBe('pending');

    s = streamingReducer(s, {
      type: 'session-update',
      notif: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'in_progress',
        },
      } as unknown as SessionNotification,
    });
    expect(s.toolCalls.get('tc-1')?.status).toBe('in_progress');

    s = streamingReducer(s, {
      type: 'session-update',
      notif: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
        },
      } as unknown as SessionNotification,
    });
    expect(s.toolCalls.get('tc-1')?.status).toBe('completed');
  });

  it('unknown SessionUpdate kind logs a warning and returns state', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notif = {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'totally_made_up_kind' },
    } as unknown as SessionNotification;
    const s = streamingReducer(initialStreamingState, { type: 'session-update', notif });
    expect(s).toBe(initialStreamingState);
    expect(warnSpy).toHaveBeenCalledWith(
      '[streaming-reducer] unhandled SessionUpdate kind:',
      'totally_made_up_kind'
    );
    warnSpy.mockRestore();
  });
});
