/**
 * Parameterised behavioural tests for the streamingReducer.
 *
 * Each transition is exercised on a fresh state so we can pinpoint a
 * regression to a single action without dragging in unrelated state.
 * The reducer is the single source of truth for the CLI's "what does
 * the renderer see" question — bugs here surface as crashes in the
 * controller and stale UI in the renderer, so we want lots of
 * coverage with little ceremony.
 */

import { describe, expect, it } from 'vitest';
import {
  detectBuiltinTag,
  extractBuiltinMeta,
  extractMcpMeta,
  initialStreamingState,
  streamingReducer,
  toolCallContentText,
  userMessage,
  type AgentMessage,
} from './streaming-reducer';

describe('streamingReducer / turn-start', () => {
  it('appends userMessage and flips isStreaming on', () => {
    const msg = userMessage('hello');
    const next = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage: msg,
    });
    expect(next.messages).toEqual([msg]);
    expect(next.isStreaming).toBe(true);
    expect(next.streamingMessage).toBeUndefined();
    expect(next.streamingMessageId).toBeUndefined();
  });

  it('does not mutate the input state', () => {
    const before = JSON.parse(
      JSON.stringify({
        ...initialStreamingState,
        toolCalls: [],
      })
    );
    streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage: userMessage('x'),
    });
    const after = JSON.parse(
      JSON.stringify({
        ...initialStreamingState,
        toolCalls: [],
      })
    );
    expect(after).toEqual(before);
  });

  it('preserves prior messages and increments through repeated turn-starts', () => {
    const first = userMessage('first');
    const second = userMessage('second');
    let s = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage: first,
    });
    s = streamingReducer(s, { type: 'turn-end', stopReason: 'end_turn' });
    s = streamingReducer(s, { type: 'turn-start', userMessage: second });
    expect(s.messages).toEqual([first, second]);
    expect(s.turnIndex).toBe(1);
    expect(s.isStreaming).toBe(true);
  });
});

describe('streamingReducer / turn-end', () => {
  it('flips isStreaming off and bumps turnIndex', () => {
    const start = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage: userMessage('q'),
    });
    const end = streamingReducer(start, { type: 'turn-end', stopReason: 'end_turn' });
    expect(end.isStreaming).toBe(false);
    expect(end.turnIndex).toBe(1);
  });

  it.each([
    ['end_turn' as const, true],
    ['max_tokens' as const, true],
    ['tool_use' as const, true],
    ['cancelled' as const, false],
  ])('when stopReason=%s, finalMessage append=%s', (stopReason, shouldAppend) => {
    const start = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage: userMessage('q'),
    });
    const finalMessage: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
    };
    const end = streamingReducer(start, {
      type: 'turn-end',
      stopReason,
      finalMessage,
    });
    const expectedLen = shouldAppend ? 2 : 1;
    expect(end.messages).toHaveLength(expectedLen);
    if (shouldAppend) {
      expect(end.messages[1]).toBe(finalMessage);
    }
  });

  it('handles turn-end without finalMessage', () => {
    const start = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage: userMessage('q'),
    });
    const end = streamingReducer(start, { type: 'turn-end', stopReason: 'end_turn' });
    expect(end.messages).toHaveLength(1);
  });
});

describe('streamingReducer / load-start + load-end', () => {
  it('load-start raises isReplaying and clears streaming buffer', () => {
    let s = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage: userMessage('q'),
    });
    s = streamingReducer(s, { type: 'load-start' });
    expect(s.isReplaying).toBe(true);
    expect(s.streamingMessage).toBeUndefined();
    expect(s.streamingMessageId).toBeUndefined();
  });

  it('load-end with messages replaces transcript and resets toolCalls + turnIndex', () => {
    let s = streamingReducer(initialStreamingState, { type: 'load-start' });
    const replay: AgentMessage[] = [
      userMessage('previous-1'),
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ];
    s = streamingReducer(s, { type: 'load-end', messages: replay });
    expect(s.messages).toEqual(replay);
    expect(s.toolCalls.size).toBe(0);
    expect(s.turnIndex).toBe(0);
    expect(s.isReplaying).toBe(false);
  });

  it('load-end without messages just clears the replay flag', () => {
    let s = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage: userMessage('keep-me'),
    });
    s = streamingReducer(s, { type: 'load-start' });
    s = streamingReducer(s, { type: 'load-end' });
    expect(s.isReplaying).toBe(false);
    expect(s.messages).toHaveLength(1);
  });
});

describe('streamingReducer / session-update agent_message_chunk', () => {
  function chunk(text: string, opts: { messageId?: string; meta?: unknown } = {}) {
    return streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
          ...(opts.messageId ? { messageId: opts.messageId } : {}),
        },
        ...(opts.meta ? { _meta: opts.meta } : {}),
      } as never,
    });
  }

  it('seeds streamingMessage with the chunk text', () => {
    const s = chunk('hello');
    expect(s.streamingMessage).toBeDefined();
    expect(s.streamingMessage?.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('appends successive chunks under the same messageId', () => {
    let s = chunk('hel', { messageId: 'm1' });
    s = streamingReducer(s, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'lo' },
          messageId: 'm1',
        },
      } as never,
    });
    expect(s.streamingMessage?.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(s.streamingMessageId).toBe('m1');
  });

  it('starts a fresh streamingMessage when messageId changes', () => {
    let s = chunk('first', { messageId: 'm1' });
    s = streamingReducer(s, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'second' },
          messageId: 'm2',
        },
      } as never,
    });
    expect(s.streamingMessage?.content).toEqual([{ type: 'text', text: 'second' }]);
    expect(s.streamingMessageId).toBe('m2');
  });

  it('drops chunks while replaying', () => {
    let s = streamingReducer(initialStreamingState, { type: 'load-start' });
    s = streamingReducer(s, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ignored' },
        },
      } as never,
    });
    expect(s.streamingMessage).toBeUndefined();
  });

  it('carries _builtin tag from _meta into the assembled message', () => {
    const s = chunk('reply', {
      meta: { bodhi: { builtin: { command: 'help' } } },
    });
    expect(s.streamingMessage?._builtin).toEqual({ command: 'help' });
  });
});

describe('streamingReducer / session-update tool_call lifecycle', () => {
  it('tool_call inserts a ToolCallView keyed by toolCallId', () => {
    const s = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'bash: ls',
          status: 'in_progress',
          rawInput: { script: 'ls' },
        },
      } as never,
    });
    expect(s.toolCalls.size).toBe(1);
    const view = s.toolCalls.get('tc-1');
    expect(view).toMatchObject({
      toolCallId: 'tc-1',
      toolName: 'bash',
      title: 'bash: ls',
      status: 'in_progress',
    });
  });

  it('tool_call_update merges status + content, preserves rawInput', () => {
    let s = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'bash: ls',
          status: 'in_progress',
          rawInput: { script: 'ls' },
        },
      } as never,
    });
    s = streamingReducer(s, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          rawOutput: { stdout: 'README\n', exitCode: 0 },
        },
      } as never,
    });
    const view = s.toolCalls.get('tc-1');
    expect(view?.status).toBe('completed');
    expect(view?.rawInput).toEqual({ script: 'ls' });
    expect(view?.rawOutput).toEqual({ stdout: 'README\n', exitCode: 0 });
  });

  it('tool_call_update on unknown id is a no-op', () => {
    const s = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'phantom',
          status: 'completed',
        },
      } as never,
    });
    expect(s).toBe(initialStreamingState);
  });
});

describe('streamingReducer / available_commands_update', () => {
  it('replaces the available command list', () => {
    const cmds = [
      { name: 'help', description: 'Show help' },
      { name: 'info', description: 'Session info' },
    ];
    const s = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: cmds,
        },
      } as never,
    });
    expect(s.availableCommands).toEqual(cmds);
  });

  it('falls back to empty array when payload omits availableCommands', () => {
    const s = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: { sessionUpdate: 'available_commands_update' },
      } as never,
    });
    expect(s.availableCommands).toEqual([]);
  });
});

describe('streamingReducer / mcp lifecycle meta', () => {
  it.each([
    ['connected', undefined],
    ['connecting', undefined],
    ['disconnected', undefined],
    ['error', 'handshake-failed'],
  ])('mcp _meta with state=%s upserts mcpStates', (state, error) => {
    const s = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: { sessionUpdate: 'agent_message_chunk' as never },
        _meta: {
          bodhi: {
            mcp: {
              server: 'wiki',
              state,
              ...(error ? { error } : {}),
              tools: ['search'],
            },
          },
        },
      } as never,
    });
    expect(s.mcpStates.wiki).toMatchObject({
      server: 'wiki',
      state,
      tools: ['search'],
    });
    if (error) expect(s.mcpStates.wiki.error).toBe(error);
  });

  it('ignores mcp meta with unknown state', () => {
    const s = streamingReducer(initialStreamingState, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: { sessionUpdate: 'agent_message_chunk' as never },
        _meta: { bodhi: { mcp: { server: 'wiki', state: 'bogus' } } },
      } as never,
    });
    expect(s.mcpStates).toEqual(initialStreamingState.mcpStates);
  });
});

describe('streamingReducer / reset', () => {
  it('returns to initial transcript but preserves availableCommands and mcpStates', () => {
    let s = streamingReducer(initialStreamingState, {
      type: 'turn-start',
      userMessage: userMessage('one'),
    });
    s = streamingReducer(s, { type: 'turn-end', stopReason: 'end_turn' });
    // Inject mcp + commands via session-update so they're not initial.
    s = streamingReducer(s, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'foo', description: 'x' }],
        },
      },
    });
    s = streamingReducer(s, {
      type: 'session-update',
      notif: {
        sessionId: 'sid',
        update: { sessionUpdate: 'agent_message_chunk' as never },
        _meta: { bodhi: { mcp: { server: 'wiki', state: 'connected' } } },
      } as never,
    });

    const r = streamingReducer(s, { type: 'reset' });
    expect(r.messages).toEqual([]);
    expect(r.turnIndex).toBe(0);
    expect(r.isStreaming).toBe(false);
    expect(r.availableCommands).toEqual([{ name: 'foo', description: 'x' }]);
    expect(r.mcpStates).toEqual({ wiki: { server: 'wiki', state: 'connected' } });
  });
});

describe('extractMcpMeta', () => {
  it.each([
    [undefined, 'undefined meta'],
    [null, 'null meta'],
    [{}, 'empty meta'],
    [{ bodhi: null }, 'bodhi=null'],
    [{ bodhi: {} }, 'bodhi without mcp'],
    [{ bodhi: { mcp: { server: 'x' } } }, 'no state'],
    [{ bodhi: { mcp: { state: 'connected' } } }, 'no server'],
    [{ bodhi: { mcp: { server: 'x', state: 'unknown' } } }, 'invalid state'],
  ])('returns undefined for %s (%s)', meta => {
    expect(extractMcpMeta(meta as unknown)).toBeUndefined();
  });

  it('drops tools array when not all entries are strings', () => {
    const meta = extractMcpMeta({
      bodhi: { mcp: { server: 'wiki', state: 'connected', tools: ['ok', 1] } },
    });
    expect(meta?.tools).toBeUndefined();
  });

  it('keeps tools when entries are all strings', () => {
    const meta = extractMcpMeta({
      bodhi: { mcp: { server: 'wiki', state: 'connected', tools: ['a', 'b'] } },
    });
    expect(meta?.tools).toEqual(['a', 'b']);
  });
});

describe('extractBuiltinMeta', () => {
  it('returns undefined for non-object inputs', () => {
    expect(extractBuiltinMeta(undefined)).toBeUndefined();
    expect(extractBuiltinMeta('hi')).toBeUndefined();
  });

  it('parses a copy action', () => {
    const tag = extractBuiltinMeta({
      bodhi: { builtin: { command: 'copy', action: { kind: 'copy' } } },
    });
    expect(tag).toEqual({ command: 'copy', action: { kind: 'copy' } });
  });

  it.each([['mcp-add'], ['mcp-remove']])('parses an %s action with url', kind => {
    const tag = extractBuiltinMeta({
      bodhi: {
        builtin: {
          command: 'mcp',
          action: { kind, params: { url: 'https://x.example/mcp' } },
        },
      },
    });
    expect(tag?.action).toEqual({ kind, params: { url: 'https://x.example/mcp' } });
  });

  it('drops a malformed action but keeps the command tag', () => {
    const tag = extractBuiltinMeta({
      bodhi: { builtin: { command: 'copy', action: { kind: 'copy', extra: 1 } } },
    });
    expect(tag?.command).toBe('copy');
  });

  it('returns undefined when command is missing', () => {
    expect(
      extractBuiltinMeta({ bodhi: { builtin: { action: { kind: 'copy' } } } })
    ).toBeUndefined();
  });

  it('drops mcp action when params.url is missing', () => {
    const tag = extractBuiltinMeta({
      bodhi: { builtin: { command: 'mcp', action: { kind: 'mcp-add' } } },
    });
    expect(tag?.action).toBeUndefined();
  });
});

describe('detectBuiltinTag', () => {
  it.each([
    ['/help', { command: 'help' }],
    ['/info', { command: 'info' }],
    ['/info now', { command: 'info' }],
    ['/copy', { command: 'copy' }],
    ['/mcp add http://x', { command: 'mcp' }],
  ])('detects %s -> %j', (input, expected) => {
    expect(detectBuiltinTag(input)).toEqual(expected);
  });

  it.each(['no leading slash', '/notabuiltin', '/help-with-suffix', '/', '/ '])(
    'returns undefined for %s',
    input => {
      expect(detectBuiltinTag(input)).toBeUndefined();
    }
  );
});

describe('toolCallContentText', () => {
  it('joins all text content blocks with newline', () => {
    expect(
      toolCallContentText([
        { type: 'content', content: { type: 'text', text: 'a' } },
        { type: 'content', content: { type: 'text', text: 'b' } },
      ] as never)
    ).toBe('a\nb');
  });

  it.each([
    [null, ''],
    [undefined, ''],
    [[], ''],
    [[{ type: 'image', content: { type: 'text', text: 'x' } }] as never, ''],
    [[{ type: 'content', content: { type: 'image', text: 'x' } }] as never, ''],
  ])('returns "" for %j', (input, expected) => {
    expect(toolCallContentText(input as never)).toBe(expected);
  });
});
