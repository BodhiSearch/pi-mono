/**
 * Tests for `refreshMcpCatalog` and `buildSessionMeta`.
 *
 * `refreshMcpCatalog` is the join point between Bodhi's live MCP
 * catalog and the agent's per-session toggle bookkeeping; getting it
 * wrong silently breaks tool dispatch. We assert four shapes:
 *   - no host/token → reset both `mcpInstances` and `composedMcpServers`
 *   - explicit `instances` opt → skip network, compose with toggles
 *   - sessionId set → fetch toggles from `client.getSession` and apply
 *   - getSession error → fall back to no toggles (still composes)
 */

import { describe, expect, it } from 'vitest';
import { buildSessionMeta, refreshMcpCatalog } from './catalog';
import type { AppContext } from '../shell/context';
import type { ConnectionStatus, Renderer, ShellMessage, SlashCommandSummary } from '../shell/types';
import type { McpInstanceView } from './bodhi-client';
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

interface MakeCtxOptions {
  host?: string | null;
  accessToken?: string | null;
  sessionId?: string | null;
  kv?: MemKv;
  getSession?: (sid: string) => Promise<unknown>;
}

function makeCtx(opts: MakeCtxOptions = {}): { ctx: AppContext; messages: ShellMessage[] } {
  const messages: ShellMessage[] = [];
  const renderer: Renderer = {
    emit: m => {
      messages.push(m);
    },
    setStatus: (_s: ConnectionStatus) => {},
    renderHelp: (_c: SlashCommandSummary[]) => {},
  };
  const settings = {
    load: async () => ({
      host: opts.host ?? null,
      tokens: opts.accessToken ? { accessToken: opts.accessToken } : null,
    }),
  } as unknown as AppContext['settings'];
  const ctx: AppContext = {
    settings,
    host: { kv: opts.kv ?? makeKv() } as unknown as AppContext['host'],
    client: {
      getSession: opts.getSession ?? (async () => ({})),
    } as unknown as AppContext['client'],
    renderer,
    opener: {} as AppContext['opener'],
    cwd: '/tmp',
    stream: {} as AppContext['stream'],
    sessionId: opts.sessionId ?? null,
    modelId: null,
    status: { kind: 'disconnected' as const },
    tokens: opts.accessToken
      ? ({ accessToken: opts.accessToken } as unknown as AppContext['tokens'])
      : null,
    composedMcpServers: [],
    mcpInstances: [],
    requestedMcps: [],
    isDev: true,
  };
  return { ctx, messages };
}

const SAMPLE_INSTANCES: McpInstanceView[] = [
  {
    id: 'i-1',
    slug: 'wiki',
    name: 'Wiki',
    description: null,
    enabled: true,
    path: '/bodhi/v1/apps/mcps/i-1/mcp',
    authType: 'oauth',
  },
  {
    id: 'i-2',
    slug: 'notes',
    name: 'Notes',
    description: null,
    enabled: true,
    path: '/bodhi/v1/apps/mcps/i-2/mcp',
    authType: 'oauth',
  },
];

describe('refreshMcpCatalog', () => {
  it('zeroes out catalog + composed servers when host is missing', async () => {
    const { ctx } = makeCtx({ host: null, accessToken: 't' });
    ctx.mcpInstances = SAMPLE_INSTANCES;
    ctx.composedMcpServers = [{ name: 'stale', url: 'x', headers: [] }] as never;
    const result = await refreshMcpCatalog(ctx);
    expect(result).toEqual({ instances: [], composedServers: [] });
    expect(ctx.mcpInstances).toEqual([]);
    expect(ctx.composedMcpServers).toEqual([]);
  });

  it('zeroes out catalog when token is missing', async () => {
    const { ctx } = makeCtx({ host: 'https://bodhi.local', accessToken: null });
    const result = await refreshMcpCatalog(ctx);
    expect(result).toEqual({ instances: [], composedServers: [] });
  });

  it('uses opts.instances to skip the network fetch and composes servers', async () => {
    const { ctx } = makeCtx({
      host: 'https://bodhi.local',
      accessToken: 'tkn',
      kv: makeKv({ [KV_REQUESTED_MCPS]: ['https://wiki.example/mcp'] }),
    });
    const result = await refreshMcpCatalog(ctx, { instances: SAMPLE_INSTANCES });
    expect(result.instances).toEqual(SAMPLE_INSTANCES);
    expect(result.composedServers).toHaveLength(2);
    expect(result.composedServers[0]).toMatchObject({
      name: 'wiki',
      url: 'https://bodhi.local/bodhi/v1/apps/mcps/i-1/mcp',
    });
    expect(result.composedServers[0].headers).toEqual([
      { name: 'Authorization', value: 'Bearer tkn' },
    ]);
    expect(ctx.requestedMcps).toEqual(['https://wiki.example/mcp']);
  });

  it('drops trailing slashes from the bodhiBaseUrl', async () => {
    const { ctx } = makeCtx({
      host: 'https://bodhi.local///',
      accessToken: 'tkn',
    });
    const result = await refreshMcpCatalog(ctx, { instances: [SAMPLE_INSTANCES[0]] });
    expect(result.composedServers[0].url).toBe('https://bodhi.local/bodhi/v1/apps/mcps/i-1/mcp');
  });

  it('honours per-session toggles when sessionId is set', async () => {
    const { ctx } = makeCtx({
      host: 'https://bodhi.local',
      accessToken: 'tkn',
      sessionId: 'sid',
      getSession: async () => ({
        mcpToggles: { servers: { wiki: false }, tools: {} },
      }),
    });
    const result = await refreshMcpCatalog(ctx, { instances: SAMPLE_INSTANCES });
    // wiki is disabled by toggles → only notes survives.
    expect(result.composedServers.map(s => s.name)).toEqual(['notes']);
  });

  it('falls back to no toggles when getSession throws', async () => {
    const { ctx } = makeCtx({
      host: 'https://bodhi.local',
      accessToken: 'tkn',
      sessionId: 'sid',
      getSession: async () => {
        throw new Error('boom');
      },
    });
    const result = await refreshMcpCatalog(ctx, { instances: SAMPLE_INSTANCES });
    // Both survive: toggles default to "enabled".
    expect(result.composedServers.map(s => s.name)).toEqual(['wiki', 'notes']);
  });

  it('reads requestedMcps from kv and writes back to ctx', async () => {
    const kv = makeKv({ [KV_REQUESTED_MCPS]: ['https://x.example/mcp', 'https://y.example/mcp'] });
    const { ctx } = makeCtx({
      host: 'https://bodhi.local',
      accessToken: 'tkn',
      kv,
    });
    await refreshMcpCatalog(ctx, { instances: [] });
    expect(ctx.requestedMcps).toEqual(['https://x.example/mcp', 'https://y.example/mcp']);
  });
});

describe('buildSessionMeta', () => {
  it('returns undefined when both inputs are empty', async () => {
    const { ctx } = makeCtx();
    expect(buildSessionMeta(ctx)).toBeUndefined();
  });

  it('emits requestedMcpUrls only when no instances are present', async () => {
    const { ctx } = makeCtx();
    ctx.requestedMcps = ['https://wiki.example/mcp'];
    const meta = buildSessionMeta(ctx);
    expect(meta).toEqual({
      requestedMcpUrls: ['https://wiki.example/mcp'],
      mcpInstances: [],
    });
  });

  it('emits mcpInstances only when no requestedMcps are present', async () => {
    const { ctx } = makeCtx();
    ctx.mcpInstances = [SAMPLE_INSTANCES[0]];
    const meta = buildSessionMeta(ctx);
    expect(meta).toEqual({
      requestedMcpUrls: [],
      mcpInstances: [{ slug: 'wiki', name: 'Wiki', path: '/bodhi/v1/apps/mcps/i-1/mcp' }],
    });
  });

  it('returns a copy of requestedMcps (no aliasing)', async () => {
    const { ctx } = makeCtx();
    ctx.requestedMcps = ['a', 'b'];
    const meta = buildSessionMeta(ctx);
    ctx.requestedMcps.push('c');
    expect(meta?.requestedMcpUrls).toEqual(['a', 'b']);
  });
});
