/**
 * Behavioural tests for the client-side built-in action dispatcher.
 *
 * The dispatcher is invoked from the StreamController whenever the
 * agent stamps a `_meta.bodhi.builtin.action` envelope on a session
 * update. Bugs here either mutate the wrong store key (breaking
 * `/mcp list`) or print the wrong message (confusing the user about
 * whether their click did anything). Both are easy to ship and hard to
 * eyeball, so we parameterise.
 */

import { describe, expect, it } from 'vitest';
import { createBuiltinActionDispatcher, renderConversationMarkdown } from './builtin-dispatch';
import { KV_REQUESTED_MCPS } from '../storage/kv-keys';
import type { AppContext } from '../shell/context';
import type { ConnectionStatus, Renderer, ShellMessage, SlashCommandSummary } from '../shell/types';

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
    get<T>(k: string) {
      return store.get(k) as T | undefined;
    },
    set<T>(k: string, v: T) {
      store.set(k, v);
    },
    delete(k: string) {
      store.delete(k);
    },
  };
}

function makeRenderer() {
  const messages: ShellMessage[] = [];
  const renderer: Renderer = {
    emit: m => {
      messages.push(m);
    },
    setStatus: (_s: ConnectionStatus) => {},
    renderHelp: (_c: SlashCommandSummary[]) => {},
  };
  return { renderer, messages };
}

interface MakeCtxOptions {
  kv?: MemKv;
  getSession?: (sid: string) => Promise<{ messages?: unknown[] }>;
}

function makeCtx(opts: MakeCtxOptions = {}): {
  ctx: AppContext;
  messages: ShellMessage[];
  kv: MemKv;
} {
  const kv = opts.kv ?? makeKv();
  const { renderer, messages } = makeRenderer();
  const ctx = {
    settings: {} as AppContext['settings'],
    host: { kv } as unknown as AppContext['host'],
    client: {
      getSession: opts.getSession ?? (async () => ({ messages: [] })),
    } as unknown as AppContext['client'],
    renderer,
    opener: {} as AppContext['opener'],
    cwd: '/tmp',
    stream: {} as AppContext['stream'],
    sessionId: null,
    modelId: null,
    status: { kind: 'disconnected' as const },
    tokens: null,
    composedMcpServers: [],
    mcpInstances: [],
    requestedMcps: [],
    isDev: true,
  } as AppContext;
  return { ctx, messages, kv };
}

describe('builtin-dispatch / mcp-add', () => {
  it('writes the canonicalised URL to kv and to ctx.requestedMcps', async () => {
    const { ctx, kv, messages } = makeCtx();
    const dispatch = createBuiltinActionDispatcher(ctx);
    await dispatch({
      action: { kind: 'mcp-add', params: { url: 'HTTPS://Wiki.Example/mcp' } },
      sessionId: 'sid',
      messages: [],
    });
    expect(kv.get<string[]>(KV_REQUESTED_MCPS)).toHaveLength(1);
    expect(ctx.requestedMcps).toHaveLength(1);
    // Canonicalisation: lower-case scheme + host, keep path.
    const stored = kv.get<string[]>(KV_REQUESTED_MCPS)![0];
    expect(stored).toMatch(/^https:\/\/wiki\.example/i);
    expect(messages.at(-1)?.kind).toBe('info');
    expect(messages.at(-1)?.text).toMatch(/Added MCP wishlist entry/);
    expect(messages.at(-1)?.text).toMatch(/\/login/);
  });

  it('is a no-op when the URL is already in the wishlist', async () => {
    const { ctx, kv, messages } = makeCtx();
    const dispatch = createBuiltinActionDispatcher(ctx);
    const url = 'https://wiki.example/mcp';
    await dispatch({
      action: { kind: 'mcp-add', params: { url } },
      sessionId: null,
      messages: [],
    });
    const before = [...kv.get<string[]>(KV_REQUESTED_MCPS)!];
    messages.length = 0;
    await dispatch({
      action: { kind: 'mcp-add', params: { url } },
      sessionId: null,
      messages: [],
    });
    expect(kv.get<string[]>(KV_REQUESTED_MCPS)).toEqual(before);
    expect(messages).toEqual([]);
  });

  it('emits an error for an unparseable URL and does not mutate state', async () => {
    const { ctx, kv, messages } = makeCtx();
    const dispatch = createBuiltinActionDispatcher(ctx);
    await dispatch({
      action: { kind: 'mcp-add', params: { url: 'not-a-url' } },
      sessionId: null,
      messages: [],
    });
    expect(kv.get<string[]>(KV_REQUESTED_MCPS)).toBeUndefined();
    expect(messages.at(-1)?.kind).toBe('error');
  });
});

describe('builtin-dispatch / mcp-remove', () => {
  it('removes a canonicalised URL from kv', async () => {
    const seedUrl = 'https://wiki.example/mcp';
    const { ctx, kv, messages } = makeCtx({
      kv: makeKv({ [KV_REQUESTED_MCPS]: [seedUrl] }),
    });
    const dispatch = createBuiltinActionDispatcher(ctx);
    await dispatch({
      action: { kind: 'mcp-remove', params: { url: 'HTTPS://Wiki.Example/mcp' } },
      sessionId: null,
      messages: [],
    });
    expect(kv.get<string[]>(KV_REQUESTED_MCPS)).toEqual([]);
    expect(ctx.requestedMcps).toEqual([]);
    expect(messages.at(-1)?.text).toMatch(/Removed MCP wishlist entry/);
  });

  it('is a no-op when the URL is absent', async () => {
    const { ctx, kv, messages } = makeCtx({
      kv: makeKv({ [KV_REQUESTED_MCPS]: ['https://other.example/mcp'] }),
    });
    const dispatch = createBuiltinActionDispatcher(ctx);
    await dispatch({
      action: { kind: 'mcp-remove', params: { url: 'https://wiki.example/mcp' } },
      sessionId: null,
      messages: [],
    });
    expect(kv.get<string[]>(KV_REQUESTED_MCPS)).toEqual(['https://other.example/mcp']);
    expect(messages).toEqual([]);
  });

  it('falls back to raw input when canonicalisation fails (still removes)', async () => {
    const { ctx, kv } = makeCtx({
      kv: makeKv({ [KV_REQUESTED_MCPS]: ['not-a-url'] }),
    });
    const dispatch = createBuiltinActionDispatcher(ctx);
    await dispatch({
      action: { kind: 'mcp-remove', params: { url: 'not-a-url' } },
      sessionId: null,
      messages: [],
    });
    expect(kv.get<string[]>(KV_REQUESTED_MCPS)).toEqual([]);
  });
});

describe('builtin-dispatch / copy', () => {
  it('emits "Nothing to copy yet." when transcript is empty', async () => {
    const { ctx, messages } = makeCtx();
    const dispatch = createBuiltinActionDispatcher(ctx);
    await dispatch({
      action: { kind: 'copy' },
      sessionId: null,
      messages: [],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toMatch(/Nothing to copy/);
  });

  it('uses the print-fallback path when stdout is not a TTY', async () => {
    const { ctx, messages } = makeCtx();
    const dispatch = createBuiltinActionDispatcher(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write');
    const original = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    try {
      await dispatch({
        action: { kind: 'copy' },
        sessionId: null,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        ],
      });
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = original;
      stdoutSpy.mockRestore();
    }
    // No OSC 52 write should have happened.
    const osc52Calls = stdoutSpy.mock.calls.filter(
      ([chunk]) => typeof chunk === 'string' && chunk.includes('\x1b]52;')
    );
    expect(osc52Calls).toHaveLength(0);
    // Fallback path: emits a system message starting with "Copy from above:".
    const sysMsg = messages.find(m => m.kind === 'system');
    expect(sysMsg?.text).toMatch(/^Copy from above:/);
    expect(sysMsg?.text).toMatch(/\*\*You:\*\*/);
    expect(sysMsg?.text).toMatch(/\*\*Assistant:\*\*/);
  });

  it('writes OSC 52 sequence when stdout is a TTY (non-CI, non-dumb)', async () => {
    const { ctx, messages } = makeCtx();
    const dispatch = createBuiltinActionDispatcher(ctx);
    // Replace stdout.write directly: vi.spyOn on getter-backed properties
    // can drop calls in some Node setups, so we capture the raw writes.
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    const originalCi = process.env.CI;
    const originalTerm = process.env.TERM;
    process.stdout.write = ((chunk: unknown) => {
      if (typeof chunk === 'string') writes.push(chunk);
      return true;
    }) as unknown as typeof process.stdout.write;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    delete process.env.CI;
    process.env.TERM = 'xterm-256color';
    try {
      await dispatch({
        action: { kind: 'copy' },
        sessionId: null,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        ],
      });
    } finally {
      process.stdout.write = original as typeof process.stdout.write;
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
      if (originalCi) process.env.CI = originalCi;
      if (originalTerm) process.env.TERM = originalTerm;
      else delete process.env.TERM;
    }
    const osc52 = writes.filter(w => w.includes('\x1b]52;c;'));
    expect(osc52).toHaveLength(1);
    // Encoded transcript should round-trip through base64. The regex
    // intentionally embeds the OSC 52 control bytes (ESC + BEL).
    // eslint-disable-next-line no-control-regex
    const match = osc52[0].match(/\x1b\]52;c;(.+?)\x07/);
    expect(match).toBeTruthy();
    const decoded = Buffer.from(match![1], 'base64').toString('utf8');
    expect(decoded).toMatch(/\*\*You:\*\*/);
    expect(decoded).toMatch(/\*\*Assistant:\*\*/);
    expect(messages.find(m => m.kind === 'system')?.text).toMatch(/OSC 52/);
  });

  it('prefers fresh server snapshot over in-memory messages when sessionId set', async () => {
    const fresh = [
      { role: 'user', content: [{ type: 'text', text: 'fresh question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'fresh answer' }] },
    ];
    const { ctx, messages } = makeCtx({
      getSession: async () => ({ messages: fresh }),
    });
    const dispatch = createBuiltinActionDispatcher(ctx);
    const original = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    try {
      await dispatch({
        action: { kind: 'copy' },
        sessionId: 'sid',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'stale' }] }],
      });
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = original;
    }
    const sysMsg = messages.find(m => m.kind === 'system');
    expect(sysMsg?.text).toMatch(/fresh question/);
    expect(sysMsg?.text).toMatch(/fresh answer/);
    expect(sysMsg?.text).not.toMatch(/stale/);
  });

  it('falls back to in-memory messages when getSession throws', async () => {
    const { ctx, messages } = makeCtx({
      getSession: async () => {
        throw new Error('snapshot unavailable');
      },
    });
    const dispatch = createBuiltinActionDispatcher(ctx);
    const original = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    try {
      await dispatch({
        action: { kind: 'copy' },
        sessionId: 'sid',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'in-memory' }] }],
      });
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = original;
    }
    const sysMsg = messages.find(m => m.kind === 'system');
    expect(sysMsg?.text).toMatch(/in-memory/);
  });
});

describe('renderConversationMarkdown', () => {
  it('skips messages tagged with _builtin', () => {
    const out = renderConversationMarkdown([
      { role: 'user', content: [{ type: 'text', text: '/info' }], _builtin: { command: 'info' } },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'session info...' }],
        _builtin: { command: 'info' },
      },
      { role: 'user', content: [{ type: 'text', text: 'real question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'real answer' }] },
    ]);
    expect(out).not.toMatch(/info/);
    expect(out).toMatch(/real question/);
    expect(out).toMatch(/real answer/);
  });

  it('skips toolResult messages', () => {
    const out = renderConversationMarkdown([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'should-not-leak' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);
    expect(out).not.toMatch(/should-not-leak/);
  });

  it.each([
    [[{ role: 'user', content: [{ type: 'text', text: '   ' }] }], ''],
    [[{ role: 'assistant', content: [] }], ''],
    [[], ''],
  ])('returns "" for trivial inputs', (msgs, expected) => {
    expect(renderConversationMarkdown(msgs as never)).toBe(expected);
  });

  it('uses **You:** and **Assistant:** banners', () => {
    const out = renderConversationMarkdown([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(out).toMatch(/\*\*You:\*\*\n\nhi/);
    expect(out).toMatch(/\*\*Assistant:\*\*\n\nhello/);
  });

  it('handles string-typed content (legacy shape)', () => {
    const out = renderConversationMarkdown([{ role: 'user', content: 'plain string' }] as never);
    expect(out).toMatch(/plain string/);
  });
});
