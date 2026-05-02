/**
 * Behavioural tests for the `/mcp` slash command.
 *
 * Covers wishlist mutation (kv-only, no network), per-session
 * toggle dispatch (RPC mock), and the renderer formatting around
 * the live state meta. Catalog refresh is short-circuited by leaving
 * `ctx.status.kind === 'disconnected'`.
 */

import { describe, expect, it } from 'vitest';
import { mcpCommand } from './mcp';
import type { AppContext } from '../shell/context';
import type { ConnectionStatus, Renderer, ShellMessage } from '../shell/types';
import type { McpConnectionMeta } from '../acp/streaming-reducer';
import type { McpInstanceView } from '../mcp/bodhi-client';
import { KV_REQUESTED_MCPS } from '../storage/kv-keys';

interface MemKv {
  store: Map<string, unknown>;
  get<T>(k: string): T | undefined;
  set<T>(k: string, v: T): void;
  delete(k: string): void;
}

function makeKv(seed: Record<string, unknown> = {}): MemKv {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    store,
    get: <T>(k: string) => store.get(k) as T | undefined,
    set: <T>(k: string, v: T) => {
      store.set(k, v);
    },
    delete: (k: string) => {
      store.delete(k);
    },
  };
}

interface FakeClient {
  callLog: { method: string; args: unknown[] }[];
  setMcpToggle: (sid: string, slug: string, value: boolean, tool?: string) => Promise<unknown>;
}

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  const callLog: { method: string; args: unknown[] }[] = [];
  return {
    callLog,
    setMcpToggle:
      overrides.setMcpToggle ??
      (async (sid, slug, value, tool) => {
        callLog.push({ method: 'setMcpToggle', args: [sid, slug, value, tool] });
        return { applied: true };
      }),
  };
}

function makeStream(mcpStates: Record<string, McpConnectionMeta> = {}) {
  const state = { mcpStates };
  return {
    state,
    getState: () => state,
    dispatch: () => {},
  };
}

interface MakeCtxOptions {
  client: FakeClient;
  kv: MemKv;
  mcpInstances?: McpInstanceView[];
  mcpStates?: Record<string, McpConnectionMeta>;
  sessionId?: string | null;
  status?: ConnectionStatus;
}

function makeCtx(opts: MakeCtxOptions): { ctx: AppContext; messages: ShellMessage[] } {
  const messages: ShellMessage[] = [];
  const renderer: Renderer = {
    emit: m => {
      messages.push(m);
    },
    setStatus: () => {},
    renderHelp: () => {},
  };
  const ctx: AppContext = {
    settings: {
      load: async () => ({ host: null, tokens: null }),
    } as unknown as AppContext['settings'],
    host: { kv: opts.kv } as unknown as AppContext['host'],
    client: opts.client as unknown as AppContext['client'],
    renderer,
    opener: {} as AppContext['opener'],
    cwd: '/tmp',
    stream: makeStream(opts.mcpStates) as unknown as AppContext['stream'],
    sessionId: 'sessionId' in opts ? (opts.sessionId ?? null) : 'sid-1',
    modelId: null,
    status: opts.status ?? { kind: 'disconnected' as const },
    tokens: null,
    composedMcpServers: [],
    mcpInstances: opts.mcpInstances ?? [],
    requestedMcps: [],
    isDev: true,
  };
  return { ctx, messages };
}

async function run(ctx: AppContext, ...args: string[]) {
  await mcpCommand.handler!(ctx, args);
}

describe('mcp / list', () => {
  it('says "No MCP servers configured." when both lists are empty', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient(), kv: makeKv() });
    await run(ctx, 'list');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toMatch(/No MCP servers configured/);
  });

  it('renders instances with state markers and tool counts', async () => {
    const instances: McpInstanceView[] = [
      { slug: 'wiki', name: 'Wiki', resource: 'mcp:wiki', baseUrl: 'https://wiki/mcp' },
      { slug: 'notes', name: 'Notes', resource: 'mcp:notes', baseUrl: 'https://notes/mcp' },
    ] as never;
    const { ctx, messages } = makeCtx({
      client: makeClient(),
      kv: makeKv(),
      mcpInstances: instances,
      mcpStates: {
        wiki: { server: 'wiki', state: 'connected', tools: ['search', 'fetch'] },
        notes: { server: 'notes', state: 'error', error: 'auth' },
      },
    });
    await run(ctx, 'list');
    const text = messages[0].text!;
    expect(text).toMatch(/Instances \(1\/2 connected\):/);
    expect(text).toMatch(/wiki\s+connected \[2 tools\]/);
    expect(text).toMatch(/notes\s+error.*auth/);
  });

  it('renders a "Pending or denied" section for wishlist URLs that lack instances', async () => {
    const { ctx, messages } = makeCtx({
      client: makeClient(),
      kv: makeKv({
        [KV_REQUESTED_MCPS]: ['https://wiki.example/mcp', 'https://other.example/mcp'],
      }),
      mcpInstances: [
        {
          slug: 'wiki',
          name: 'Wiki',
          resource: 'mcp:wiki',
          baseUrl: 'https://wiki.example/mcp',
        } as never,
      ],
    });
    await run(ctx, 'list');
    const text = messages[0].text!;
    expect(text).toMatch(/Pending or denied \(1\)/);
    expect(text).toMatch(/https:\/\/other\.example\/mcp/);
    expect(text).not.toMatch(/Pending or denied .*wiki/s);
  });

  it('treats `ls` as an alias of `list`', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient(), kv: makeKv() });
    await run(ctx, 'ls');
    expect(messages).toHaveLength(1);
  });
});

describe('mcp / add', () => {
  it('rejects empty input with usage hint', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient(), kv: makeKv() });
    await run(ctx, 'add');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Usage: \/mcp add/);
  });

  it.each(['not-a-url', '   ', ''])('rejects unparseable URL %j', async input => {
    const { ctx, messages } = makeCtx({ client: makeClient(), kv: makeKv() });
    await run(ctx, 'add', input);
    if (input.trim() === '') {
      expect(messages.at(-1)?.text).toMatch(/Usage: \/mcp add|Not a valid MCP URL/);
    } else {
      expect(messages.at(-1)?.kind).toBe('error');
      expect(messages.at(-1)?.text).toMatch(/Not a valid MCP URL/);
    }
  });

  it('appends a canonicalised URL and surfaces /login hint', async () => {
    const kv = makeKv();
    const { ctx, messages } = makeCtx({ client: makeClient(), kv });
    await run(ctx, 'add', 'HTTPS://Wiki.Example/mcp');
    const stored = kv.get<string[]>(KV_REQUESTED_MCPS);
    expect(stored).toHaveLength(1);
    expect(stored![0]).toMatch(/^https:\/\/wiki\.example/i);
    expect(messages.at(-1)?.text).toMatch(/Run \/login to refresh/);
  });

  it('says "Already in list" without mutating kv on duplicate', async () => {
    const url = 'https://wiki.example/mcp';
    const kv = makeKv({ [KV_REQUESTED_MCPS]: [url] });
    const { ctx, messages } = makeCtx({ client: makeClient(), kv });
    await run(ctx, 'add', url);
    expect(kv.get<string[]>(KV_REQUESTED_MCPS)).toEqual([url]);
    expect(messages.at(-1)?.text).toMatch(/Already in list/);
  });
});

describe('mcp / remove', () => {
  it('rejects empty input with usage hint', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient(), kv: makeKv() });
    await run(ctx, 'remove');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Usage: \/mcp remove/);
  });

  it('says "Not in list" when URL is absent', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient(), kv: makeKv() });
    await run(ctx, 'remove', 'https://x.example/mcp');
    expect(messages.at(-1)?.text).toMatch(/Not in list/);
  });

  it('removes a canonicalised URL', async () => {
    const url = 'https://wiki.example/mcp';
    const kv = makeKv({ [KV_REQUESTED_MCPS]: [url] });
    const { ctx, messages } = makeCtx({ client: makeClient(), kv });
    await run(ctx, 'remove', 'HTTPS://Wiki.Example/mcp');
    expect(kv.get<string[]>(KV_REQUESTED_MCPS)).toEqual([]);
    expect(messages.at(-1)?.text).toMatch(/Removed/);
  });

  it('falls back to raw input for an unparseable URL (still removes)', async () => {
    const kv = makeKv({ [KV_REQUESTED_MCPS]: ['not-a-url'] });
    const { ctx } = makeCtx({ client: makeClient(), kv });
    await run(ctx, 'remove', 'not-a-url');
    expect(kv.get<string[]>(KV_REQUESTED_MCPS)).toEqual([]);
  });

  it('supports the "rm" alias', async () => {
    const url = 'https://wiki.example/mcp';
    const kv = makeKv({ [KV_REQUESTED_MCPS]: [url] });
    const { ctx, messages } = makeCtx({ client: makeClient(), kv });
    await run(ctx, 'rm', url);
    expect(messages.at(-1)?.text).toMatch(/Removed/);
  });
});

describe('mcp / on|off', () => {
  it('rejects missing target with usage hint', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient(), kv: makeKv() });
    await run(ctx, 'on');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Usage: \/mcp on/);
  });

  it('errors when no session is active', async () => {
    const { ctx, messages } = makeCtx({
      client: makeClient(),
      kv: makeKv(),
      sessionId: null,
    });
    await run(ctx, 'on', 'wiki');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/No active session/);
  });

  it.each([
    ['on', true],
    ['off', false],
  ])('toggles a server slug via setMcpToggle (%s)', async (verb, expected) => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client, kv: makeKv() });
    await run(ctx, verb, 'wiki');
    expect(client.callLog).toEqual([
      { method: 'setMcpToggle', args: ['sid-1', 'wiki', expected, undefined] },
    ]);
    expect(messages.at(-1)?.text).toMatch(new RegExp(`'wiki' set to ${verb}`));
  });

  it('toggles individual tools when given slug:tool1,tool2', async () => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client, kv: makeKv() });
    await run(ctx, 'on', 'wiki:search,fetch');
    expect(client.callLog).toEqual([
      { method: 'setMcpToggle', args: ['sid-1', 'wiki', true, 'search'] },
      { method: 'setMcpToggle', args: ['sid-1', 'wiki', true, 'fetch'] },
    ]);
    expect(messages.at(-1)?.text).toMatch(/wiki: 2 tool\(s\) set to on/);
  });

  it('errors when ":" is followed by an empty tool list', async () => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({ client, kv: makeKv() });
    await run(ctx, 'on', 'wiki:');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/No tools specified/);
  });

  it('strips whitespace from tool list entries', async () => {
    const client = makeClient();
    const { ctx } = makeCtx({ client, kv: makeKv() });
    await run(ctx, 'on', 'wiki:  search ,  fetch  ');
    expect(client.callLog).toEqual([
      { method: 'setMcpToggle', args: ['sid-1', 'wiki', true, 'search'] },
      { method: 'setMcpToggle', args: ['sid-1', 'wiki', true, 'fetch'] },
    ]);
  });
});

describe('mcp / unknown', () => {
  it('emits an error', async () => {
    const { ctx, messages } = makeCtx({ client: makeClient(), kv: makeKv() });
    await run(ctx, 'whoops');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Unknown \/mcp action/);
  });
});
