import { describe, expect, test, vi } from 'vitest';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { ExtensionRunner } from './runner';
import type {
  BeforeAgentStartEvent,
  ContextEvent,
  Extension,
  ExtensionContext,
  ExtensionEventHandler,
  ExtensionUIContext,
  MessageEndEvent,
  SessionLoadedEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnStartEvent,
} from './types';

const noopUI: ExtensionUIContext = {
  notify: () => {},
  setStatus: () => {},
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
};

function makeExtension(name: string, setup: (ext: Extension) => void = () => {}): Extension {
  const ext: Extension = {
    name,
    path: `/vault/.pi/extensions/${name}`,
    entryPath: `/vault/.pi/extensions/${name}/index.js`,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };
  setup(ext);
  return ext;
}

function setHandler<E>(
  ext: Extension,
  eventType: string,
  handler: ExtensionEventHandler<E, unknown>
): void {
  const bucket = ext.handlers.get(eventType) ?? [];
  bucket.push(handler as ExtensionEventHandler<unknown, unknown>);
  ext.handlers.set(eventType, bucket);
}

const baseContext: ExtensionContext = {
  cwd: '/vault',
  isIdle: () => true,
  abort: () => {},
  ui: noopUI,
  hasUI: true,
};

describe('ExtensionRunner', () => {
  test('emitBeforeAgentStart returns undefined when no handlers are registered', async () => {
    const runner = new ExtensionRunner();
    const out = await runner.emitBeforeAgentStart(
      { type: 'before_agent_start', prompt: 'hi', systemPrompt: 'base' },
      baseContext
    );
    expect(out).toBeUndefined();
  });

  test('before_agent_start handlers chain — later sees earlier override', async () => {
    const runner = new ExtensionRunner();
    const a = makeExtension('a', e =>
      setHandler<BeforeAgentStartEvent>(e, 'before_agent_start', event => ({
        systemPrompt: `${event.systemPrompt}+a`,
      }))
    );
    const b = makeExtension('b', e =>
      setHandler<BeforeAgentStartEvent>(e, 'before_agent_start', event => ({
        systemPrompt: `${event.systemPrompt}+b`,
      }))
    );
    runner.setExtensions([a, b]);
    const out = await runner.emitBeforeAgentStart(
      { type: 'before_agent_start', prompt: 'hi', systemPrompt: 'base' },
      baseContext
    );
    expect(out).toBe('base+a+b');
  });

  test('before_agent_start handler throw is isolated via onError', async () => {
    const runner = new ExtensionRunner();
    const errors: string[] = [];
    runner.onError(err => errors.push(err.error));
    const bad = makeExtension('bad', e =>
      setHandler<BeforeAgentStartEvent>(e, 'before_agent_start', () => {
        throw new Error('boom');
      })
    );
    const good = makeExtension('good', e =>
      setHandler<BeforeAgentStartEvent>(e, 'before_agent_start', event => ({
        systemPrompt: `${event.systemPrompt}!`,
      }))
    );
    runner.setExtensions([bad, good]);
    const out = await runner.emitBeforeAgentStart(
      { type: 'before_agent_start', prompt: 'x', systemPrompt: 'base' },
      baseContext
    );
    expect(out).toBe('base!');
    expect(errors).toEqual(['boom']);
  });

  test('tool_result overrides apply field-by-field with no deep merge', async () => {
    const runner = new ExtensionRunner();
    const a = makeExtension('a', e =>
      setHandler<ToolResultEvent>(e, 'tool_result', () => ({
        content: [{ type: 'text', text: 'from-a' }],
      }))
    );
    const b = makeExtension('b', e =>
      setHandler<ToolResultEvent>(e, 'tool_result', () => ({
        isError: true,
      }))
    );
    runner.setExtensions([a, b]);
    const out = await runner.emitToolResult(
      {
        type: 'tool_result',
        toolCallId: 'c1',
        toolName: 't',
        input: {},
        content: [{ type: 'text', text: 'original' }],
        details: undefined,
        isError: false,
      },
      baseContext
    );
    expect(out).toEqual({
      content: [{ type: 'text', text: 'from-a' }],
      isError: true,
    });
  });

  test('tool_result returns undefined when no handlers registered', async () => {
    const runner = new ExtensionRunner();
    const out = await runner.emitToolResult(
      {
        type: 'tool_result',
        toolCallId: 'c1',
        toolName: 't',
        input: {},
        content: [],
        details: undefined,
        isError: false,
      },
      baseContext
    );
    expect(out).toBeUndefined();
  });

  test('getAllRegisteredTools / getRegisteredCommands dedupe by name across extensions', () => {
    const runner = new ExtensionRunner();
    const tool = {
      definition: { name: 't', description: 'd', parameters: {} as never, execute: vi.fn() },
      extensionPath: '/ext/a',
    };
    const a = makeExtension('a', e => e.tools.set('t', tool));
    const b = makeExtension('b', e => e.tools.set('t', { ...tool, extensionPath: '/ext/b' }));
    runner.setExtensions([a, b]);
    expect(runner.getAllRegisteredTools()).toHaveLength(1);
    expect(runner.getAllRegisteredTools()[0]!.extensionPath).toBe('/ext/a');
  });

  test('findCommand locates by name across extensions', () => {
    const runner = new ExtensionRunner();
    const cmd = {
      name: 'c',
      handler: async () => {},
      extensionPath: '/ext/a',
    };
    const a = makeExtension('a', e => e.commands.set('c', cmd));
    runner.setExtensions([a]);
    expect(runner.findCommand('c')?.extensionPath).toBe('/ext/a');
    expect(runner.findCommand('missing')).toBeNull();
  });

  test('clear drops extensions', () => {
    const runner = new ExtensionRunner();
    runner.setExtensions([makeExtension('a')]);
    runner.clear();
    expect(runner.hasExtensions()).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Phase 2a: context / tool_call / lifecycle dispatch
  // --------------------------------------------------------------------------

  test('emitContext returns undefined when no handlers are registered', async () => {
    const runner = new ExtensionRunner();
    const out = await runner.emitContext([], baseContext);
    expect(out).toBeUndefined();
  });

  test('emitContext chains handlers — later sees earlier override', async () => {
    const runner = new ExtensionRunner();
    const append = (tag: string) => (event: ContextEvent) => ({
      messages: [...event.messages, { role: 'user', content: tag } as unknown as AgentMessage],
    });
    const a = makeExtension('a', e => setHandler<ContextEvent>(e, 'context', append('a')));
    const b = makeExtension('b', e => setHandler<ContextEvent>(e, 'context', append('b')));
    runner.setExtensions([a, b]);
    const out = await runner.emitContext(
      [{ role: 'user', content: 'base' } as unknown as AgentMessage],
      baseContext
    );
    expect(out).toBeDefined();
    expect(out).toHaveLength(3);
    expect((out as AgentMessage[]).map(m => (m as { content: string }).content)).toEqual([
      'base',
      'a',
      'b',
    ]);
  });

  test('emitContext errors are isolated via onError', async () => {
    const runner = new ExtensionRunner();
    const errors: string[] = [];
    runner.onError(err => errors.push(err.event));
    const bad = makeExtension('bad', e =>
      setHandler<ContextEvent>(e, 'context', () => {
        throw new Error('boom');
      })
    );
    const good = makeExtension('good', e =>
      setHandler<ContextEvent>(e, 'context', event => ({
        messages: [...event.messages, { role: 'user', content: 'g' } as unknown as AgentMessage],
      }))
    );
    runner.setExtensions([bad, good]);
    const out = await runner.emitContext(
      [{ role: 'user', content: 'x' } as unknown as AgentMessage],
      baseContext
    );
    expect(out).toHaveLength(2);
    expect(errors).toEqual(['context']);
  });

  test('emitToolCall mutation in place propagates to later handlers and executor', async () => {
    const runner = new ExtensionRunner();
    const mutate = makeExtension('mutate', e =>
      setHandler<ToolCallEvent>(e, 'tool_call', event => {
        event.input.mutated = true;
      })
    );
    const observe = makeExtension('observe', e =>
      setHandler<ToolCallEvent>(e, 'tool_call', event => {
        event.input.observed = event.input.mutated === true;
      })
    );
    runner.setExtensions([mutate, observe]);
    const event: ToolCallEvent = {
      type: 'tool_call',
      toolCallId: 'c1',
      toolName: 't',
      input: {},
    };
    const outcome = await runner.emitToolCall(event, baseContext);
    expect(outcome).toEqual({ blocked: false });
    expect(event.input).toEqual({ mutated: true, observed: true });
  });

  test('emitToolCall returns first block + reason; subsequent handlers not run', async () => {
    const runner = new ExtensionRunner();
    const ran: string[] = [];
    const first = makeExtension('first', e =>
      setHandler<ToolCallEvent>(e, 'tool_call', () => {
        ran.push('first');
        return { block: true, reason: 'denied' };
      })
    );
    const second = makeExtension('second', e =>
      setHandler<ToolCallEvent>(e, 'tool_call', () => {
        ran.push('second');
      })
    );
    runner.setExtensions([first, second]);
    const outcome = await runner.emitToolCall(
      { type: 'tool_call', toolCallId: 'c1', toolName: 't', input: {} },
      baseContext
    );
    expect(outcome).toEqual({ blocked: true, reason: 'denied' });
    expect(ran).toEqual(['first']);
  });

  test('emitToolCall errors are isolated and do not block', async () => {
    const runner = new ExtensionRunner();
    const errors: string[] = [];
    runner.onError(err => errors.push(err.event));
    const bad = makeExtension('bad', e =>
      setHandler<ToolCallEvent>(e, 'tool_call', () => {
        throw new Error('boom');
      })
    );
    runner.setExtensions([bad]);
    const outcome = await runner.emitToolCall(
      { type: 'tool_call', toolCallId: 'c1', toolName: 't', input: {} },
      baseContext
    );
    expect(outcome).toEqual({ blocked: false });
    expect(errors).toEqual(['tool_call']);
  });

  test('emitTurnStart / emitMessageEnd / emitSessionLoaded fan out observers and isolate errors', async () => {
    const runner = new ExtensionRunner();
    const errors: string[] = [];
    runner.onError(err => errors.push(err.event));
    const calls: string[] = [];
    const a = makeExtension('a', e => {
      setHandler<TurnStartEvent>(e, 'turn_start', () => {
        calls.push('a:turn_start');
      });
      setHandler<MessageEndEvent>(e, 'message_end', ev => {
        calls.push(`a:message_end:${(ev.message as { role: string }).role}`);
      });
      setHandler<SessionLoadedEvent>(e, 'session_loaded', ev => {
        calls.push(`a:session_loaded:${ev.reason}`);
      });
    });
    const b = makeExtension('b', e => {
      setHandler<TurnStartEvent>(e, 'turn_start', () => {
        throw new Error('boom-turn');
      });
      setHandler<MessageEndEvent>(e, 'message_end', () => {
        calls.push('b:message_end');
      });
    });
    runner.setExtensions([a, b]);

    await runner.emitTurnStart(baseContext);
    await runner.emitMessageEnd(
      { role: 'user', content: 'hi' } as unknown as AgentMessage,
      baseContext
    );
    await runner.emitSessionLoaded({ type: 'session_loaded', reason: 'reload' }, baseContext);

    expect(calls.sort()).toEqual(
      ['a:turn_start', 'a:message_end:user', 'a:session_loaded:reload', 'b:message_end'].sort()
    );
    expect(errors).toContain('turn_start');
  });

  test('onError returns a disposer', () => {
    const runner = new ExtensionRunner();
    const calls: string[] = [];
    const dispose = runner.onError(err => calls.push(err.error));
    dispose();
    const ext = makeExtension('x', e =>
      setHandler<BeforeAgentStartEvent>(e, 'before_agent_start', () => {
        throw new Error('nope');
      })
    );
    runner.setExtensions([ext]);
    void runner.emitBeforeAgentStart(
      { type: 'before_agent_start', prompt: '', systemPrompt: '' },
      baseContext
    );
    expect(calls).toEqual([]);
  });
});
