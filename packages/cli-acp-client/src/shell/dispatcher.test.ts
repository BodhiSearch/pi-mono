import { describe, expect, it } from 'vitest';
import { CommandRegistry, type SlashCommand } from './registry';
import { createDispatcher } from './dispatcher';
import type { AppContext } from './context';
import type { ConnectionStatus, Renderer, ShellMessage, SlashCommandSummary } from './types';

function makeRecorder() {
  const messages: ShellMessage[] = [];
  const statuses: ConnectionStatus[] = [];
  const renderer: Renderer = {
    emit(message) {
      messages.push(message);
    },
    setStatus(status) {
      statuses.push(status);
    },
    renderHelp(_cmds: SlashCommandSummary[]) {
      messages.push({ kind: 'info', text: 'help' });
    },
  };
  return { renderer, messages, statuses };
}

function makeCtx(renderer: Renderer): AppContext {
  return {
    settings: {} as AppContext['settings'],
    host: {} as AppContext['host'],
    client: {} as AppContext['client'],
    renderer,
    opener: {} as AppContext['opener'],
    cwd: '/tmp',
    sessionId: null,
    modelId: null,
    status: { kind: 'disconnected' },
    tokens: null,
    composedMcpServers: [],
  };
}

describe('createDispatcher', () => {
  it('forwards plain prompts to the prompt handler', async () => {
    const { renderer } = makeRecorder();
    const ctx = makeCtx(renderer);
    const registry = new CommandRegistry();
    const seen: string[] = [];
    const dispatcher = createDispatcher(ctx, registry, async text => {
      seen.push(text);
    });
    await dispatcher.submit('hello there');
    expect(seen).toEqual(['hello there']);
  });

  it('routes slash commands to the registry', async () => {
    const { renderer, messages } = makeRecorder();
    const ctx = makeCtx(renderer);
    const registry = new CommandRegistry();
    let invokedWith: string[] | undefined;
    const ping: SlashCommand = {
      name: 'ping',
      description: 'ping',
      async handler(_ctx, args) {
        invokedWith = args;
      },
    };
    registry.register(ping);
    const dispatcher = createDispatcher(ctx, registry, async () => {});
    await dispatcher.submit('/ping foo bar');
    expect(invokedWith).toEqual(['foo', 'bar']);
    expect(messages).toEqual([]);
  });

  it('emits an error for unknown commands', async () => {
    const { renderer, messages } = makeRecorder();
    const ctx = makeCtx(renderer);
    const registry = new CommandRegistry();
    const dispatcher = createDispatcher(ctx, registry, async () => {});
    await dispatcher.submit('/unknown');
    expect(messages.length).toBe(1);
    expect(messages[0].kind).toBe('error');
    expect(messages[0].text).toMatch(/Unknown command/);
  });

  it('catches handler errors and emits chain + stack via renderer', async () => {
    const { renderer, messages } = makeRecorder();
    const ctx = makeCtx(renderer);
    const registry = new CommandRegistry();
    registry.register({
      name: 'boom',
      description: 'boom',
      async handler() {
        throw new Error('kaboom');
      },
    });
    const dispatcher = createDispatcher(ctx, registry, async () => {});
    await dispatcher.submit('/boom');
    expect(messages.length).toBe(2);
    expect(messages[0].kind).toBe('error');
    expect(messages[0].text).toMatch(/kaboom/);
    expect(messages[1].kind).toBe('error');
    expect(messages[1].text).toMatch(/at /);
  });
});
