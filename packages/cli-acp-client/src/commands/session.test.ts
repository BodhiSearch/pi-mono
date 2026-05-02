/**
 * Behavioural tests for `/session list|new|load|delete`.
 *
 * `/session load` is the rewritten replay path the user hit hardest;
 * we want every piece of its choreography pinned down: cancel-in-flight,
 * pre-fetch snapshot, dispatch load-start before the network call,
 * dispatch load-end after, restore lastModelId, and emit a sane info
 * line. Failures must surface load-end (no stuck spinner) and an
 * error message.
 *
 * Network fan-out (refreshMcpCatalog) is short-circuited by passing a
 * settings store with `host=null`, so we never touch the wire.
 */

import { describe, expect, it } from 'vitest';
import { sessionCommand } from './session';
import type { AppContext } from '../shell/context';
import type { ConnectionStatus, Renderer, ShellMessage, SlashCommandSummary } from '../shell/types';
import { KV_LAST_MODEL_ID } from '../storage/kv-keys';

interface FakeClient {
  callLog: { method: string; args: unknown[] }[];
  listSessions: () => Promise<Array<{ id: string; turnCount: number; title?: string }>>;
  newSession: (cwd: string, mcps: unknown, meta: unknown) => Promise<{ sessionId: string }>;
  loadSession: (id: string, cwd: string, mcps: unknown, meta: unknown) => Promise<void>;
  getSession: (id: string) => Promise<{
    messages?: unknown[];
    mcpToggles?: {
      servers: Record<string, boolean>;
      tools: Record<string, Record<string, boolean>>;
    };
    lastModelId?: string;
  }>;
  deleteSession: (id: string) => Promise<boolean>;
  cancel: (sid: string) => Promise<void>;
}

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  const callLog: { method: string; args: unknown[] }[] = [];
  return {
    callLog,
    listSessions:
      overrides.listSessions ??
      (async () => {
        callLog.push({ method: 'listSessions', args: [] });
        return [];
      }),
    newSession:
      overrides.newSession ??
      (async (cwd, mcps, meta) => {
        callLog.push({ method: 'newSession', args: [cwd, mcps, meta] });
        return { sessionId: 'new-sid' };
      }),
    loadSession:
      overrides.loadSession ??
      (async (id, cwd, mcps, meta) => {
        callLog.push({ method: 'loadSession', args: [id, cwd, mcps, meta] });
      }),
    getSession:
      overrides.getSession ??
      (async id => {
        callLog.push({ method: 'getSession', args: [id] });
        return { messages: [] };
      }),
    deleteSession:
      overrides.deleteSession ??
      (async id => {
        callLog.push({ method: 'deleteSession', args: [id] });
        return true;
      }),
    cancel:
      overrides.cancel ??
      (async sid => {
        callLog.push({ method: 'cancel', args: [sid] });
      }),
  };
}

interface FakeStream {
  state: { isStreaming: boolean };
  dispatched: Array<{ type: string; messages?: unknown[] }>;
  getState: () => { isStreaming: boolean };
  dispatch: (a: { type: string; messages?: unknown[] }) => void;
}

function makeStream(opts: { isStreaming?: boolean } = {}): FakeStream {
  const state = { isStreaming: !!opts.isStreaming };
  const dispatched: Array<{ type: string; messages?: unknown[] }> = [];
  return {
    state,
    dispatched,
    getState: () => state,
    dispatch: a => dispatched.push(a),
  };
}

interface MemKv {
  store: Map<string, unknown>;
  get<T>(k: string): T | undefined;
  set<T>(k: string, v: T): void;
  delete(k: string): void;
}

function makeKv(): MemKv {
  const store = new Map<string, unknown>();
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

function makeCtx(opts: {
  client: FakeClient;
  stream: FakeStream;
  kv: MemKv;
  sessionId?: string | null;
  host?: string | null;
}): { ctx: AppContext; messages: ShellMessage[] } {
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
      tokens: null,
    }),
  } as unknown as AppContext['settings'];
  const ctx: AppContext = {
    settings,
    host: { kv: opts.kv } as unknown as AppContext['host'],
    client: opts.client as unknown as AppContext['client'],
    renderer,
    opener: {} as AppContext['opener'],
    cwd: '/tmp',
    stream: opts.stream as unknown as AppContext['stream'],
    sessionId: 'sessionId' in opts ? (opts.sessionId ?? null) : null,
    modelId: null,
    status: { kind: 'disconnected' as const },
    tokens: null,
    composedMcpServers: [],
    mcpInstances: [],
    requestedMcps: [],
    isDev: true,
  };
  return { ctx, messages };
}

async function run(ctx: AppContext, ...args: string[]) {
  await sessionCommand.handler!(ctx, args);
}

describe('session / list', () => {
  it('says "No sessions yet." for an empty store', async () => {
    const { ctx, messages } = makeCtx({
      client: makeClient(),
      stream: makeStream(),
      kv: makeKv(),
    });
    await run(ctx, 'list');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toMatch(/No sessions yet/);
  });

  it('renders one line per session with truncated id + title', async () => {
    const { ctx, messages } = makeCtx({
      client: makeClient({
        listSessions: async () => [
          { id: 'aaaaaaaaaaaaaaaaaaa1', turnCount: 3, title: 'first' },
          { id: 'bbbbbbbbbbbbbbbbbbb2', turnCount: 0 },
        ],
      }),
      stream: makeStream(),
      kv: makeKv(),
    });
    await run(ctx, 'list');
    const text = messages[0].text!;
    expect(text).toMatch(/Sessions \(2\):/);
    expect(text).toMatch(/aaaaaaaaaaaa…/);
    expect(text).toMatch(/turns=3/);
    expect(text).toMatch(/first/);
    expect(text).toMatch(/\(untitled\)/);
  });

  it('treats no subcommand as "list"', async () => {
    const { ctx, messages } = makeCtx({
      client: makeClient(),
      stream: makeStream(),
      kv: makeKv(),
    });
    await run(ctx);
    expect(messages.at(-1)?.text).toMatch(/No sessions yet|Sessions \(/);
  });
});

describe('session / new', () => {
  it('calls newSession and stamps ctx.sessionId', async () => {
    const client = makeClient();
    const { ctx, messages } = makeCtx({
      client,
      stream: makeStream(),
      kv: makeKv(),
    });
    await run(ctx, 'new');
    const call = client.callLog.find(c => c.method === 'newSession');
    expect(call).toBeDefined();
    expect(ctx.sessionId).toBe('new-sid');
    expect(messages.at(-1)?.text).toMatch(/Created session new-sid/);
  });
});

describe('session / load', () => {
  it('rejects missing id with usage hint', async () => {
    const { ctx, messages } = makeCtx({
      client: makeClient(),
      stream: makeStream(),
      kv: makeKv(),
    });
    await run(ctx, 'load');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Usage: \/session load/);
  });

  it('cancels an in-flight stream before loading', async () => {
    const FULL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const client = makeClient();
    const stream = makeStream({ isStreaming: true });
    const { ctx } = makeCtx({
      client,
      stream,
      kv: makeKv(),
      sessionId: 'old-sid',
    });
    await run(ctx, 'load', FULL);
    expect(client.callLog.find(c => c.method === 'cancel')?.args).toEqual(['old-sid']);
    expect(stream.dispatched[0]).toEqual({ type: 'load-start' });
  });

  it('skips cancel when not currently streaming', async () => {
    const FULL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const client = makeClient();
    const stream = makeStream({ isStreaming: false });
    const { ctx } = makeCtx({
      client,
      stream,
      kv: makeKv(),
      sessionId: 'old-sid',
    });
    await run(ctx, 'load', FULL);
    expect(client.callLog.find(c => c.method === 'cancel')).toBeUndefined();
  });

  it('replays messages, sets sessionId, restores lastModelId', async () => {
    const FULL = 'targetsi-bbbb-cccc-dddd-eeeeeeeeeeee';
    const replayMessages = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ];
    const client = makeClient({
      getSession: async () => ({
        messages: replayMessages,
        lastModelId: 'haiku-3.5',
        mcpToggles: { servers: {}, tools: {} },
      }),
    });
    const stream = makeStream();
    const kv = makeKv();
    const { ctx, messages } = makeCtx({ client, stream, kv });
    await run(ctx, 'load', FULL);
    expect(ctx.sessionId).toBe(FULL);
    expect(ctx.modelId).toBe('haiku-3.5');
    expect(kv.get<string>(KV_LAST_MODEL_ID)).toBe('haiku-3.5');
    expect(stream.dispatched[0]).toEqual({ type: 'load-start' });
    expect(stream.dispatched.at(-1)).toEqual({ type: 'load-end', messages: replayMessages });
    expect(messages.at(-1)?.text).toMatch(
      /Loaded session targetsi-bbbb-cccc-dddd-eeeeeeeeeeee \(2 message\(s\), model=haiku-3\.5\)/
    );
  });

  it('emits load-end and an error when getSession throws', async () => {
    const FULL = 'missings-bbbb-cccc-dddd-eeeeeeeeeeee';
    const client = makeClient({
      getSession: async () => {
        throw new Error('snapshot 404');
      },
    });
    const stream = makeStream();
    const { ctx, messages } = makeCtx({ client, stream, kv: makeKv() });
    await run(ctx, 'load', FULL);
    expect(stream.dispatched[0]).toEqual({ type: 'load-start' });
    expect(stream.dispatched.at(-1)).toEqual({ type: 'load-end' });
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Failed to load session.*snapshot 404/);
  });

  it('does not touch lastModelId when the snapshot omits it', async () => {
    const FULL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const client = makeClient({
      getSession: async () => ({ messages: [] }),
    });
    const stream = makeStream();
    const kv = makeKv();
    const { ctx } = makeCtx({ client, stream, kv });
    await run(ctx, 'load', FULL);
    expect(ctx.modelId).toBeNull();
    expect(kv.get<string>(KV_LAST_MODEL_ID)).toBeUndefined();
  });

  it('treats missing snapshot.messages as zero-length transcript', async () => {
    const client = makeClient({
      getSession: async () => ({}),
    });
    const stream = makeStream();
    const { ctx, messages } = makeCtx({ client, stream, kv: makeKv() });
    await run(ctx, 'load', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(stream.dispatched.at(-1)).toEqual({ type: 'load-end', messages: [] });
    expect(messages.at(-1)?.text).toMatch(/0 message\(s\)/);
  });

  it('resolves a prefix to the full id when unambiguous', async () => {
    const fullId = 'abcd1234-5678-90ab-cdef-1122334455aa';
    const client = makeClient({
      listSessions: async () => [{ id: fullId, turnCount: 0 }],
      getSession: async sid => {
        expect(sid).toBe(fullId);
        return { messages: [] };
      },
    });
    const { ctx, messages } = makeCtx({ client, stream: makeStream(), kv: makeKv() });
    await run(ctx, 'load', 'abcd1234');
    expect(ctx.sessionId).toBe(fullId);
    expect(messages.at(-1)?.text).toMatch(/Loaded session abcd1234-5678-90ab-cdef-1122334455aa/);
  });

  it('errors when prefix matches no sessions', async () => {
    const client = makeClient({
      listSessions: async () => [{ id: 'aaaa-1234-5678-90ab-cdef-1122334455aa', turnCount: 0 }],
    });
    const { ctx, messages } = makeCtx({ client, stream: makeStream(), kv: makeKv() });
    await run(ctx, 'load', 'zzzz');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/No session matches 'zzzz'/);
  });

  it('errors when prefix matches multiple sessions', async () => {
    const client = makeClient({
      listSessions: async () => [
        { id: 'abcd1234-aaaa-bbbb-cccc-dddddddddddd', turnCount: 0 },
        { id: 'abcd1234-zzzz-bbbb-cccc-dddddddddddd', turnCount: 0 },
      ],
    });
    const { ctx, messages } = makeCtx({ client, stream: makeStream(), kv: makeKv() });
    await run(ctx, 'load', 'abcd1234');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Multiple sessions match 'abcd1234'/);
  });
});

describe('session / delete', () => {
  it('rejects missing id with usage hint', async () => {
    const { ctx, messages } = makeCtx({
      client: makeClient(),
      stream: makeStream(),
      kv: makeKv(),
    });
    await run(ctx, 'delete');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Usage: \/session delete/);
  });

  it('emits "Deleted" when client confirms removal', async () => {
    const FULL = 'sid1aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { ctx, messages } = makeCtx({
      client: makeClient({ deleteSession: async () => true }),
      stream: makeStream(),
      kv: makeKv(),
    });
    await run(ctx, 'delete', FULL);
    expect(messages.at(-1)?.text).toMatch(new RegExp(`Deleted session ${FULL}`));
  });

  it('emits "No session" when client returns false', async () => {
    const FULL = 'sidxaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { ctx, messages } = makeCtx({
      client: makeClient({ deleteSession: async () => false }),
      stream: makeStream(),
      kv: makeKv(),
    });
    await run(ctx, 'delete', FULL);
    expect(messages.at(-1)?.text).toMatch(new RegExp(`No session ${FULL}`));
  });

  it('clears sessionId and dispatches reset when deleting the active session', async () => {
    const FULL = 'sid1aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const stream = makeStream();
    const { ctx } = makeCtx({
      client: makeClient({ deleteSession: async () => true }),
      stream,
      kv: makeKv(),
      sessionId: FULL,
    });
    await run(ctx, 'delete', FULL);
    expect(ctx.sessionId).toBeNull();
    expect(stream.dispatched.at(-1)).toEqual({ type: 'reset' });
  });

  it('does NOT touch sessionId when deleting an inactive session', async () => {
    const ACTIVE = 'sid-acti-bbbb-cccc-dddd-eeeeeeeeeeee';
    const OTHER = 'sid-othe-bbbb-cccc-dddd-eeeeeeeeeeee';
    const stream = makeStream();
    const { ctx } = makeCtx({
      client: makeClient({ deleteSession: async () => true }),
      stream,
      kv: makeKv(),
      sessionId: ACTIVE,
    });
    await run(ctx, 'delete', OTHER);
    expect(ctx.sessionId).toBe(ACTIVE);
    expect(stream.dispatched).toEqual([]);
  });

  it('supports the "rm" alias', async () => {
    const FULL = 'sidraaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { ctx, messages } = makeCtx({
      client: makeClient({ deleteSession: async () => true }),
      stream: makeStream(),
      kv: makeKv(),
    });
    await run(ctx, 'rm', FULL);
    expect(messages.at(-1)?.text).toMatch(new RegExp(`Deleted session ${FULL}`));
  });
});

describe('session / unknown', () => {
  it('emits an error', async () => {
    const { ctx, messages } = makeCtx({
      client: makeClient(),
      stream: makeStream(),
      kv: makeKv(),
    });
    await run(ctx, 'whoops');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Unknown \/session action/);
  });
});
