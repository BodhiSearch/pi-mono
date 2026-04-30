import { describe, expect, it } from 'vitest';
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

  it('replay guard suppresses live chunks but lets MCP and command updates through', () => {
    const replaying = streamingReducer(initialStreamingState, { type: 'load-start' });
    expect(replaying.isReplaying).toBe(true);

    const blocked = streamingReducer(replaying, {
      type: 'session-update',
      notif: chunk('should not render', { messageId: 'm-1' }),
    });
    expect(blocked.streamingMessage).toBeUndefined();

    const cmdNotif = {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'help', description: '/help' }],
      },
    } as unknown as SessionNotification;
    const withCmds = streamingReducer(replaying, { type: 'session-update', notif: cmdNotif });
    expect(withCmds.availableCommands).toHaveLength(1);

    const mcpNotif = {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
      _meta: { bodhi: { mcp: { server: 'srv-1', state: 'connected' } } },
    } as unknown as SessionNotification;
    const withMcp = streamingReducer(replaying, { type: 'session-update', notif: mcpNotif });
    expect(withMcp.mcpStates['srv-1']).toEqual({ server: 'srv-1', state: 'connected' });
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

  it('appends finalMessage on turn-end and bumps turnIndex', () => {
    const userMessage = makeMsg('user', 'hi');
    const finalMessage = makeMsg('assistant', 'hello');
    let s: StreamingState = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage,
    });
    s = streamingReducer(s, {
      type: 'turn-end',
      stopReason: 'end_turn',
      finalMessage,
    });
    expect(s.messages).toEqual([userMessage, finalMessage]);
    expect(s.streamingMessage).toBeUndefined();
    expect(s.isStreaming).toBe(false);
    expect(s.turnIndex).toBe(1);
  });

  it('drops finalMessage on turn-end when stopReason is cancelled', () => {
    const userMessage = makeMsg('user', 'hi');
    const finalMessage = makeMsg('assistant', 'partial');
    let s: StreamingState = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage,
    });
    s = streamingReducer(s, {
      type: 'turn-end',
      stopReason: 'cancelled',
      finalMessage,
    });
    expect(s.messages).toEqual([userMessage]);
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
});
