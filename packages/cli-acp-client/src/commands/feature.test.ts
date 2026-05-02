/**
 * Behavioural tests for `/feature list|<key> on|off|set <key> <on|off>`.
 *
 * The command talks to the agent via two RPC calls. We stub the
 * `AcpClient` to a tiny shape and assert the surfaced renderer text
 * because that's what users react to (and it's where the DEV-mode
 * hint lives, which is hard to spot without an explicit assertion).
 */

import { describe, expect, it } from 'vitest';
import { featureCommand } from './feature';
import type { AppContext } from '../shell/context';
import type { ConnectionStatus, Renderer, ShellMessage, SlashCommandSummary } from '../shell/types';

interface FakeClient {
  listFeatures: (
    sid: string
  ) => Promise<{ features: Record<string, boolean>; defaults: Record<string, boolean> }>;
  setFeature: (
    sid: string,
    key: string,
    value: boolean
  ) => Promise<{ features: Record<string, boolean> }>;
  callLog: { method: string; args: unknown[] }[];
}

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  const callLog: { method: string; args: unknown[] }[] = [];
  return {
    listFeatures:
      overrides.listFeatures ??
      (async sid => {
        callLog.push({ method: 'listFeatures', args: [sid] });
        return {
          features: {},
          defaults: { bashEnabled: true, forceToolCall: false },
        };
      }),
    setFeature:
      overrides.setFeature ??
      (async (sid, key, value) => {
        callLog.push({ method: 'setFeature', args: [sid, key, value] });
        return { features: { [key]: value } };
      }),
    callLog,
  };
}

function makeCtx(opts: { client: FakeClient; sessionId?: string | null; isDev?: boolean }): {
  ctx: AppContext;
  messages: ShellMessage[];
} {
  const messages: ShellMessage[] = [];
  const renderer: Renderer = {
    emit: m => {
      messages.push(m);
    },
    setStatus: (_s: ConnectionStatus) => {},
    renderHelp: (_c: SlashCommandSummary[]) => {},
  };
  const ctx: AppContext = {
    settings: {} as AppContext['settings'],
    host: {} as AppContext['host'],
    client: opts.client as unknown as AppContext['client'],
    renderer,
    opener: {} as AppContext['opener'],
    cwd: '/tmp',
    stream: {} as AppContext['stream'],
    sessionId: 'sessionId' in opts ? (opts.sessionId ?? null) : 'sid-1',
    modelId: null,
    status: { kind: 'disconnected' as const },
    tokens: null,
    composedMcpServers: [],
    mcpInstances: [],
    requestedMcps: [],
    isDev: opts.isDev ?? true,
  };
  return { ctx, messages };
}

async function run(ctx: AppContext, ...args: string[]) {
  await featureCommand.handler!(ctx, args);
}

describe('feature / list', () => {
  it('emits an info message when no session is active', async () => {
    const { ctx, messages } = makeCtx({
      client: makeClient(),
      sessionId: null,
    });
    await run(ctx, 'list');
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe('info');
    expect(messages[0].text).toMatch(/No active session/);
  });

  it('renders defaults with "(default)" suffix when nothing is overridden', async () => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client });
    await run(ctx, 'list');
    expect(messages).toHaveLength(1);
    const text = messages[0].text!;
    expect(text).toMatch(/Features \(session sid-1\):/);
    expect(text).toMatch(/bashEnabled\s+on \(default\)/);
    expect(text).toMatch(/forceToolCall\s+off \(default\)/);
  });

  it('drops the "(default)" suffix when a feature is overridden', async () => {
    const client = makeClient({
      listFeatures: async () => ({
        features: { bashEnabled: false },
        defaults: { bashEnabled: true, forceToolCall: false },
      }),
    });
    const { ctx, messages } = makeCtx({ client });
    await run(ctx, 'list');
    const text = messages[0].text!;
    expect(text).toMatch(/bashEnabled\s+off($|[\s\n])/);
    expect(text).not.toMatch(/bashEnabled\s+off \(default\)/);
  });

  it('appends "[no-op outside DEV mode]" for forceToolCall when isDev=false', async () => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client, isDev: false });
    await run(ctx, 'list');
    const text = messages[0].text!;
    expect(text).toMatch(/forceToolCall.*\[no-op outside DEV mode\]/);
    expect(text).not.toMatch(/bashEnabled.*\[no-op/);
  });

  it('does not append the DEV hint when isDev=true', async () => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client, isDev: true });
    await run(ctx, 'list');
    const text = messages[0].text!;
    expect(text).not.toMatch(/\[no-op/);
  });

  it('surfaces an error when listFeatures throws', async () => {
    const client = makeClient({
      listFeatures: async () => {
        throw new Error('rpc broke');
      },
    });
    const { ctx, messages } = makeCtx({ client });
    await run(ctx, 'list');
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe('error');
    expect(messages[0].text).toMatch(/Failed to list features.*rpc broke/);
  });
});

describe('feature / set', () => {
  it.each([
    ['/feature bashEnabled on', 'bashEnabled', true],
    ['/feature bashEnabled off', 'bashEnabled', false],
    ['/feature bashEnabled true', 'bashEnabled', true],
    ['/feature bashEnabled false', 'bashEnabled', false],
    ['/feature bashEnabled 1', 'bashEnabled', true],
    ['/feature bashEnabled 0', 'bashEnabled', false],
    ['/feature bashEnabled yes', 'bashEnabled', true],
    ['/feature bashEnabled no', 'bashEnabled', false],
  ])('parses %s', async (_label, key, value) => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client });
    await run(ctx, key, value ? 'on' : 'off');
    expect(client.callLog.find(c => c.method === 'setFeature')?.args).toEqual([
      'sid-1',
      key,
      value,
    ]);
    expect(messages.at(-1)?.text).toMatch(new RegExp(`'${key}' set to ${value ? 'on' : 'off'}`));
  });

  it('falls through to "list" when called with no args', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient() });
    await run(ctx);
    expect(messages.at(-1)?.kind).toBe('info');
    expect(messages.at(-1)?.text).toMatch(/Features \(session sid-1\):/);
  });

  it('emits an error when value is missing', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient() });
    await run(ctx, 'bashEnabled');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Usage: \/feature/);
  });

  it('errors when no session is active', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient(), sessionId: null });
    await run(ctx, 'bashEnabled', 'on');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/No active session/);
  });

  it('errors on unparseable value (e.g. "maybe")', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient() });
    await run(ctx, 'bashEnabled', 'maybe');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Cannot parse 'maybe'/);
  });

  it('emits a warning when key is unknown but still calls setFeature', async () => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client });
    await run(ctx, 'mysteryFlag', 'on');
    const sysWarning = messages.find(m => m.kind === 'system');
    expect(sysWarning?.text).toMatch(/'mysteryFlag' is not a known feature/);
    expect(client.callLog.find(c => c.method === 'setFeature')).toBeDefined();
  });

  it('appends "(no-op: requires DEV mode)" hint when toggling forceToolCall outside DEV', async () => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client, isDev: false });
    await run(ctx, 'forceToolCall', 'on');
    expect(messages.at(-1)?.text).toMatch(/no-op: requires DEV mode/);
  });

  it('does not append the DEV hint when toggling forceToolCall inside DEV', async () => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client, isDev: true });
    await run(ctx, 'forceToolCall', 'on');
    expect(messages.at(-1)?.text).not.toMatch(/no-op: requires DEV mode/);
  });

  it('supports the explicit "set <key> <on|off>" form', async () => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client });
    await run(ctx, 'set', 'bashEnabled', 'off');
    expect(client.callLog.find(c => c.method === 'setFeature')?.args).toEqual([
      'sid-1',
      'bashEnabled',
      false,
    ]);
    expect(messages.at(-1)?.text).toMatch(/'bashEnabled' set to off/);
  });

  it('surfaces an error when setFeature throws', async () => {
    const client = makeClient({
      setFeature: async () => {
        throw new Error('rpc rejected');
      },
    });
    const { ctx, messages } = makeCtx({ client });
    await run(ctx, 'bashEnabled', 'on');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Failed to set feature.*rpc rejected/);
  });
});
