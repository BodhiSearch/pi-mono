/**
 * Integration tests for the agent's `AcpAgentAdapter` wired against the
 * host's Dexie session store + a fake `CommandsFs`. Exercises the
 * extension methods and the built-in slash command dispatch path that
 * touches persistence.
 *
 * Lives under the host package because the agent package itself does
 * not ship a `SessionStore` implementation — only the interface. The
 * Dexie + fake-indexeddb stack is the host's responsibility.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentSideConnection,
  PromptRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  AcpAgentAdapter,
  assembleServices,
  BODHI_GET_SESSION_METHOD,
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
  type BodhiGetSessionResponse,
  type BodhiMcpTogglesSetResponse,
  type BodhiProvider,
  type BodhiSessionsDeleteResponse,
  type CommandsFs,
  type CommandsFsEntry,
  type InlineAgent,
  type SessionStore,
  type VolumeRegistry,
} from '@bodhiapp/web-acp-agent';
import { SessionStoreDb } from './db';
import { createStoreFromDb } from './session-store';
import { createMcpToggleStore } from './mcp-toggle-store';

const ADAPTER_OPTIONS = {
  isDev: false,
  buildVersion: '0.0.0-test',
  acpSdkVersion: '0.21.0-test',
};

function fakeConn(): AgentSideConnection {
  return {
    sessionUpdate: vi.fn(async () => undefined),
    extNotification: vi.fn(async () => undefined),
  } as unknown as AgentSideConnection;
}

function fakeInline(): InlineAgent {
  return {
    setModel: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    getMessages: vi.fn(() => []),
    getErrorMessage: vi.fn(() => undefined),
    prompt: vi.fn(async () => undefined),
    cancel: vi.fn(),
    clearMessages: vi.fn(),
    restoreMessages: vi.fn(),
  };
}

function fakeBodhi(): BodhiProvider {
  return {
    setAuthToken: vi.fn(),
    getAvailableModels: vi.fn(async () => []),
  } as unknown as BodhiProvider;
}

describe('AcpAgentAdapter MCP toggle ext methods', () => {
  let db: SessionStoreDb;
  let store: SessionStore;
  let adapter: AcpAgentAdapter;

  beforeEach(async () => {
    db = new SessionStoreDb(`web-acp-adapter-${crypto.randomUUID()}`);
    store = createStoreFromDb(db);
    const toggles = createMcpToggleStore(db);
    adapter = new AcpAgentAdapter(
      fakeConn(),
      assembleServices({
        inline: fakeInline(),
        bodhi: fakeBodhi(),
        store,
        mcpToggles: toggles,
      }),
      ADAPTER_OPTIONS
    );
    await store.createSession('s1');
  });

  afterEach(async () => {
    await db.delete();
    db.close();
  });

  it('bodhi/getSession returns an empty toggle snapshot when no overrides are stored', async () => {
    const raw = await adapter.extMethod(BODHI_GET_SESSION_METHOD, { sessionId: 's1' });
    const resp = raw as BodhiGetSessionResponse;
    expect(resp.sessionId).toBe('s1');
    expect(resp.mcpToggles).toEqual({ servers: {}, tools: {} });
  });

  it('_bodhi/mcp/toggles/set stores a server-level override and returns the snapshot', async () => {
    const raw = await adapter.extMethod(BODHI_MCP_TOGGLES_SET_METHOD, {
      sessionId: 's1',
      serverSlug: 'everything',
      value: false,
    });
    const resp = raw as BodhiMcpTogglesSetResponse;
    expect(resp.toggles.servers).toEqual({ everything: false });
    expect(resp.toggles.tools).toEqual({});

    const getRaw = await adapter.extMethod(BODHI_GET_SESSION_METHOD, { sessionId: 's1' });
    const getResp = getRaw as BodhiGetSessionResponse;
    expect(getResp.mcpToggles.servers).toEqual({ everything: false });
  });

  it('_bodhi/mcp/toggles/set stores a per-tool override when toolName is provided', async () => {
    const raw = await adapter.extMethod(BODHI_MCP_TOGGLES_SET_METHOD, {
      sessionId: 's1',
      serverSlug: 'everything',
      toolName: 'get-sum',
      value: false,
    });
    const resp = raw as BodhiMcpTogglesSetResponse;
    expect(resp.toggles.tools).toEqual({ everything: { 'get-sum': false } });
    expect(resp.toggles.servers).toEqual({});
  });

  it('_bodhi/mcp/toggles/set rejects malformed params', async () => {
    await expect(
      adapter.extMethod(BODHI_MCP_TOGGLES_SET_METHOD, { sessionId: 's1', value: true })
    ).rejects.toThrow(/invalid params/);
    await expect(
      adapter.extMethod(BODHI_MCP_TOGGLES_SET_METHOD, { sessionId: 's1', serverSlug: 'x' })
    ).rejects.toThrow(/invalid params/);
  });

  it('_bodhi/sessions/delete removes the row and returns deleted: true', async () => {
    await store.recordNotification('s1', {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    } as Parameters<SessionStore['recordNotification']>[1]);
    const raw = await adapter.extMethod(BODHI_SESSIONS_DELETE_METHOD, { sessionId: 's1' });
    const resp = raw as BodhiSessionsDeleteResponse;
    expect(resp.deleted).toBe(true);
    expect(await store.getSession('s1')).toBeUndefined();
    expect(await store.readEntries('s1')).toHaveLength(0);
  });

  it('_bodhi/sessions/delete is idempotent — unknown ids resolve with deleted: false', async () => {
    const raw = await adapter.extMethod(BODHI_SESSIONS_DELETE_METHOD, {
      sessionId: 'does-not-exist',
    });
    const resp = raw as BodhiSessionsDeleteResponse;
    expect(resp.deleted).toBe(false);
  });

  it('_bodhi/sessions/delete rejects malformed params', async () => {
    await expect(adapter.extMethod(BODHI_SESSIONS_DELETE_METHOD, {})).rejects.toThrow(
      /invalid params/
    );
  });

  it('bodhi/getSession reflects per-server + per-tool overrides accumulated via set calls', async () => {
    await adapter.extMethod(BODHI_MCP_TOGGLES_SET_METHOD, {
      sessionId: 's1',
      serverSlug: 'everything',
      value: true,
    });
    await adapter.extMethod(BODHI_MCP_TOGGLES_SET_METHOD, {
      sessionId: 's1',
      serverSlug: 'everything',
      toolName: 'echo',
      value: false,
    });
    const raw = await adapter.extMethod(BODHI_GET_SESSION_METHOD, { sessionId: 's1' });
    const resp = raw as BodhiGetSessionResponse;
    expect(resp.mcpToggles).toEqual({
      servers: { everything: true },
      tools: { everything: { echo: false } },
    });
  });
});

class FakeCommandsFs implements CommandsFs {
  readonly files = new Map<string, string>();

  add(path: string, content: string): void {
    this.files.set(path, content);
  }

  async readdir(path: string): Promise<CommandsFsEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const direct = new Map<string, CommandsFsEntry>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const tail = f.slice(prefix.length);
      const slash = tail.indexOf('/');
      if (slash === -1) {
        direct.set(tail, { name: tail, isFile: true, isDirectory: false });
      } else {
        const dir = tail.slice(0, slash);
        if (!direct.has(dir)) direct.set(dir, { name: dir, isFile: false, isDirectory: true });
      }
    }
    return [...direct.values()];
  }

  async readFile(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f;
  }
}

interface MockRegistry {
  list(): Array<{ mountName: string; description?: string }>;
}

function makeRegistry(mountNames: string[]): MockRegistry {
  return {
    list: () => mountNames.map(mountName => ({ mountName })),
  };
}

describe('AcpAgentAdapter slash commands', () => {
  let db: SessionStoreDb;
  let store: SessionStore;
  let conn: AgentSideConnection;
  let inline: InlineAgent;
  let commandsFs: FakeCommandsFs;
  let adapter: AcpAgentAdapter;
  let updates: SessionNotification[];

  beforeEach(async () => {
    db = new SessionStoreDb(`web-acp-cmds-${crypto.randomUUID()}`);
    store = createStoreFromDb(db);
    updates = [];
    conn = {
      sessionUpdate: vi.fn(async (notif: SessionNotification) => {
        updates.push(notif);
      }),
      extNotification: vi.fn(async () => undefined),
    } as unknown as AgentSideConnection;
    inline = fakeInline();
    commandsFs = new FakeCommandsFs();
  });

  afterEach(async () => {
    await db.delete();
    db.close();
  });

  function buildAdapter(
    opts: {
      mounts?: string[];
    } = {}
  ): AcpAgentAdapter {
    const registry = opts.mounts
      ? (makeRegistry(opts.mounts) as unknown as VolumeRegistry)
      : undefined;
    return new AcpAgentAdapter(
      conn,
      assembleServices({
        inline,
        bodhi: fakeBodhi(),
        store,
        registry,
        commandsFs,
      }),
      ADAPTER_OPTIONS
    );
  }

  it('emits available_commands_update on newSession with built-ins only when no mounts are present', async () => {
    adapter = buildAdapter();
    await adapter.newSession({ cwd: '/', mcpServers: [] });
    const ac = updates.find(u => u.update.sessionUpdate === 'available_commands_update');
    expect(ac).toBeDefined();
    const cmds = (ac!.update as { availableCommands: Array<{ name: string }> }).availableCommands;
    expect(cmds.map(c => c.name).sort()).toEqual(['copy', 'help', 'info', 'mcp', 'version']);
  });

  it('emits a populated available_commands_update on newSession when commands exist', async () => {
    commandsFs.add(
      '/mnt/wiki/.pi/commands/greet.md',
      ['---', 'description: Greet someone', 'argument-hint: <name>', '---', 'Hello $1!'].join('\n')
    );
    adapter = buildAdapter({ mounts: ['wiki'] });
    await adapter.newSession({ cwd: '/', mcpServers: [] });
    const ac = updates.find(u => u.update.sessionUpdate === 'available_commands_update');
    expect(ac).toBeDefined();
    const cmds = (
      ac!.update as {
        availableCommands: Array<{ name: string; description: string; input?: { hint: string } }>;
      }
    ).availableCommands;
    const vault = cmds.filter(c => c.name.includes(':'));
    expect(vault).toEqual([
      { name: 'wiki:greet', description: 'Greet someone', input: { hint: '<name>' } },
    ]);
    const builtinNames = cmds.filter(c => !c.name.includes(':')).map(c => c.name);
    expect(builtinNames.sort()).toEqual(['copy', 'help', 'info', 'mcp', 'version']);
  });

  it('re-emits available_commands_update on loadSession', async () => {
    commandsFs.add('/mnt/wiki/.pi/commands/hello.md', '---\ndescription: hi\n---\nHi!');
    adapter = buildAdapter({ mounts: ['wiki'] });
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    updates.length = 0;
    await adapter.loadSession({ sessionId, cwd: '/', mcpServers: [] });
    const after = updates.filter(u => u.update.sessionUpdate === 'available_commands_update');
    expect(after.length).toBeGreaterThanOrEqual(1);
    const last = after[after.length - 1];
    const cmds = (last.update as { availableCommands: Array<{ name: string }> }).availableCommands;
    const vault = cmds.filter(c => c.name.includes(':'));
    expect(vault.map(c => c.name)).toEqual(['wiki:hello']);
  });

  it('expands a slash command in the prompt before calling the inline agent', async () => {
    commandsFs.add(
      '/mnt/wiki/.pi/commands/greet.md',
      '---\ndescription: greet\n---\nHello $1, welcome to $2.'
    );
    adapter = buildAdapter({ mounts: ['wiki'] });
    inline.subscribe = vi.fn(() => () => undefined);
    inline.prompt = vi.fn(async () => undefined);
    inline.getMessages = vi.fn(() => []);
    inline.getErrorMessage = vi.fn(() => undefined);
    inline.setModel = vi.fn();
    const bodhi = fakeBodhi();
    bodhi.getAvailableModels = vi.fn(async () => [
      { id: 'test-model', api: { format: 'openai' } } as unknown as Awaited<
        ReturnType<BodhiProvider['getAvailableModels']>
      >[number],
    ]);
    adapter = new AcpAgentAdapter(
      conn,
      assembleServices({
        inline,
        bodhi,
        store,
        registry: makeRegistry(['wiki']) as unknown as VolumeRegistry,
        commandsFs,
      }),
      ADAPTER_OPTIONS
    );
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    const req: PromptRequest = {
      sessionId,
      prompt: [{ type: 'text', text: '/wiki:greet alice paris' }],
    };
    await adapter.prompt(req);
    expect(inline.prompt).toHaveBeenCalledWith('Hello alice, welcome to paris.');
  });

  it('passes non-slash text through unchanged', async () => {
    commandsFs.add('/mnt/wiki/.pi/commands/greet.md', '---\ndescription: g\n---\nGreet body');
    const bodhi = fakeBodhi();
    bodhi.getAvailableModels = vi.fn(async () => [
      { id: 'test-model', api: { format: 'openai' } } as unknown as Awaited<
        ReturnType<BodhiProvider['getAvailableModels']>
      >[number],
    ]);
    adapter = new AcpAgentAdapter(
      conn,
      assembleServices({
        inline,
        bodhi,
        store,
        registry: makeRegistry(['wiki']) as unknown as VolumeRegistry,
        commandsFs,
      }),
      ADAPTER_OPTIONS
    );
    inline.prompt = vi.fn(async () => undefined);
    inline.getMessages = vi.fn(() => []);
    inline.getErrorMessage = vi.fn(() => undefined);
    inline.setModel = vi.fn();
    inline.subscribe = vi.fn(() => () => undefined);
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'just a normal message' }],
    });
    expect(inline.prompt).toHaveBeenCalledWith('just a normal message');
  });

  it('passes unknown slash commands through unchanged', async () => {
    commandsFs.add('/mnt/wiki/.pi/commands/known.md', '---\ndescription: k\n---\nknown body');
    const bodhi = fakeBodhi();
    bodhi.getAvailableModels = vi.fn(async () => [
      { id: 'test-model', api: { format: 'openai' } } as unknown as Awaited<
        ReturnType<BodhiProvider['getAvailableModels']>
      >[number],
    ]);
    adapter = new AcpAgentAdapter(
      conn,
      assembleServices({
        inline,
        bodhi,
        store,
        registry: makeRegistry(['wiki']) as unknown as VolumeRegistry,
        commandsFs,
      }),
      ADAPTER_OPTIONS
    );
    inline.prompt = vi.fn(async () => undefined);
    inline.getMessages = vi.fn(() => []);
    inline.getErrorMessage = vi.fn(() => undefined);
    inline.setModel = vi.fn();
    inline.subscribe = vi.fn(() => () => undefined);
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/wiki:nope something' }],
    });
    expect(inline.prompt).toHaveBeenCalledWith('/wiki:nope something');
  });

  it('advertises prompts from .pi/prompts/ alongside vault commands', async () => {
    commandsFs.add('/mnt/wiki/.pi/commands/greet.md', '---\ndescription: greet\n---\nHello $1!');
    commandsFs.add(
      '/mnt/wiki/.pi/prompts/poem.md',
      '---\ndescription: write a poem\nargument-hint: <topic>\n---\nA poem about $1.'
    );
    adapter = buildAdapter({ mounts: ['wiki'] });
    await adapter.newSession({ cwd: '/', mcpServers: [] });
    const ac = updates.find(u => u.update.sessionUpdate === 'available_commands_update');
    expect(ac).toBeDefined();
    const cmds = (
      ac!.update as {
        availableCommands: Array<{ name: string; description: string; input?: { hint: string } }>;
      }
    ).availableCommands;
    const vault = cmds
      .filter(c => c.name.includes(':'))
      .map(c => c.name)
      .sort();
    expect(vault).toEqual(['wiki:greet', 'wiki:poem']);
    const poem = cmds.find(c => c.name === 'wiki:poem');
    expect(poem?.description).toBe('write a poem');
    expect(poem?.input).toEqual({ hint: '<topic>' });
  });

  it('expands a prompt template through the same prompt() path as commands', async () => {
    commandsFs.add(
      '/mnt/wiki/.pi/prompts/poem.md',
      '---\ndescription: poem\n---\nWrite a haiku about $1 and $2.'
    );
    const bodhi = fakeBodhi();
    bodhi.getAvailableModels = vi.fn(async () => [
      { id: 'test-model', api: { format: 'openai' } } as unknown as Awaited<
        ReturnType<BodhiProvider['getAvailableModels']>
      >[number],
    ]);
    adapter = new AcpAgentAdapter(
      conn,
      assembleServices({
        inline,
        bodhi,
        store,
        registry: makeRegistry(['wiki']) as unknown as VolumeRegistry,
        commandsFs,
      }),
      ADAPTER_OPTIONS
    );
    inline.subscribe = vi.fn(() => () => undefined);
    inline.prompt = vi.fn(async () => undefined);
    inline.getMessages = vi.fn(() => []);
    inline.getErrorMessage = vi.fn(() => undefined);
    inline.setModel = vi.fn();
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/wiki:poem cherry spring' }],
    });
    expect(inline.prompt).toHaveBeenCalledWith('Write a haiku about cherry and spring.');
  });

  it('drops a prompt with the same canonical name as an existing command (conflict)', async () => {
    commandsFs.add(
      '/mnt/wiki/.pi/commands/dup.md',
      '---\ndescription: cmd-version\n---\nCMD-WIN body'
    );
    commandsFs.add(
      '/mnt/wiki/.pi/prompts/dup.md',
      '---\ndescription: prompt-version\n---\nPROMPT-LOSE body'
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    adapter = buildAdapter({ mounts: ['wiki'] });
    await adapter.newSession({ cwd: '/', mcpServers: [] });
    const ac = updates.find(u => u.update.sessionUpdate === 'available_commands_update');
    expect(ac).toBeDefined();
    const cmds = (ac!.update as { availableCommands: Array<{ name: string; description: string }> })
      .availableCommands;
    const dup = cmds.filter(c => c.name === 'wiki:dup');
    expect(dup).toHaveLength(1);
    expect(dup[0].description).toBe('cmd-version');
    const collisionWarn = warn.mock.calls.find(call => {
      const msg = call[0];
      return typeof msg === 'string' && msg.includes("[prompts] 'wiki:dup'");
    });
    expect(collisionWarn).toBeDefined();
    warn.mockRestore();
  });
});

describe('AcpAgentAdapter built-in slash commands', () => {
  let db: SessionStoreDb;
  let store: SessionStore;
  let conn: AgentSideConnection;
  let inline: InlineAgent;
  let updates: SessionNotification[];
  let extNotifications: Array<{ method: string; params: Record<string, unknown> }>;
  let adapter: AcpAgentAdapter;

  beforeEach(async () => {
    db = new SessionStoreDb(`web-acp-builtin-${crypto.randomUUID()}`);
    store = createStoreFromDb(db);
    updates = [];
    extNotifications = [];
    conn = {
      sessionUpdate: vi.fn(async (notif: SessionNotification) => {
        updates.push(notif);
      }),
      extNotification: vi.fn(async (method: string, params: Record<string, unknown>) => {
        extNotifications.push({ method, params });
      }),
    } as unknown as AgentSideConnection;
    inline = fakeInline();
    inline.prompt = vi.fn(async () => undefined);
    inline.getMessages = vi.fn(() => []);
    inline.getErrorMessage = vi.fn(() => undefined);
    inline.setModel = vi.fn();
    inline.subscribe = vi.fn(() => () => undefined);
    adapter = new AcpAgentAdapter(
      conn,
      assembleServices({
        inline,
        bodhi: fakeBodhi(),
        store,
      }),
      ADAPTER_OPTIONS
    );
  });

  afterEach(async () => {
    await db.delete();
    db.close();
  });

  it('does not call inline.prompt when the user input is a built-in', async () => {
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    updates.length = 0;
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/help' }],
    });
    expect(inline.prompt).not.toHaveBeenCalled();
  });

  it('emits an agent_message_chunk with _meta.bodhi.builtin', async () => {
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    updates.length = 0;
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/help' }],
    });
    const chunk = updates.find(u => u.update.sessionUpdate === 'agent_message_chunk');
    expect(chunk).toBeDefined();
    const meta = chunk!._meta as { bodhi?: { builtin?: { command?: string } } } | null;
    expect(meta?.bodhi?.builtin?.command).toBe('help');
  });

  it('persists a builtin entry distinct from turn entries', async () => {
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/help' }],
    });
    const entries = await store.readEntries(sessionId);
    const builtinEntries = entries.filter(e => e.kind === 'builtin');
    expect(builtinEntries).toHaveLength(1);
    const payload = builtinEntries[0].payload as {
      command: string;
      userText: string;
      replyText: string;
    };
    expect(payload.command).toBe('help');
    expect(payload.userText).toBe('/help');
    expect(payload.replyText.length).toBeGreaterThan(0);
  });

  it('/copy emits a copy action via extNotification when the LLM history has an assistant turn', async () => {
    inline.getMessages = vi.fn(
      () =>
        [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] },
        ] as unknown as ReturnType<InlineAgent['getMessages']>
    );
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    updates.length = 0;
    extNotifications.length = 0;
    await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: '/copy' }] });
    // Chunk carries only the command tag; action rides extNotification.
    const chunk = updates.find(u => u.update.sessionUpdate === 'agent_message_chunk');
    const meta = chunk!._meta as { bodhi?: { builtin?: { command?: string } } } | null;
    expect(meta?.bodhi?.builtin?.command).toBe('copy');
    const evt = extNotifications.find(n => n.method === '_bodhi/builtin/action');
    expect(evt).toBeDefined();
    const params = evt!.params as { command?: string; action?: { kind?: string } };
    expect(params.command).toBe('copy');
    expect(params.action?.kind).toBe('copy');
  });

  it('/copy emits no action extNotification when the conversation is empty', async () => {
    inline.getMessages = vi.fn(() => []);
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    updates.length = 0;
    extNotifications.length = 0;
    await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: '/copy' }] });
    expect(extNotifications.find(n => n.method === '_bodhi/builtin/action')).toBeUndefined();
  });

  it('a real prompt after a built-in does NOT see the built-in in inline history', async () => {
    const bodhi = fakeBodhi();
    bodhi.getAvailableModels = vi.fn(async () => [
      { id: 'test-model', api: { format: 'openai' } } as unknown as Awaited<
        ReturnType<BodhiProvider['getAvailableModels']>
      >[number],
    ]);
    const realAdapter = new AcpAgentAdapter(
      conn,
      assembleServices({
        inline,
        bodhi,
        store,
      }),
      ADAPTER_OPTIONS
    );
    const { sessionId } = await realAdapter.newSession({ cwd: '/', mcpServers: [] });
    await realAdapter.prompt({ sessionId, prompt: [{ type: 'text', text: '/help' }] });
    expect(inline.prompt).not.toHaveBeenCalled();
    await realAdapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'real follow-up' }],
    });
    expect(inline.prompt).toHaveBeenCalledTimes(1);
    expect(inline.prompt).toHaveBeenCalledWith('real follow-up');
  });

  it('bodhi/getSession interleaves built-in entries with tagged user+assistant pairs', async () => {
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: '/help' }] });
    const raw = await adapter.extMethod(BODHI_GET_SESSION_METHOD, { sessionId });
    const resp = raw as BodhiGetSessionResponse;
    expect(resp.messages).toHaveLength(2);
    const [u, a] = resp.messages as Array<{
      role: string;
      _builtin?: { command: string };
      content: Array<{ text: string }>;
    }>;
    expect(u.role).toBe('user');
    expect(u._builtin?.command).toBe('help');
    expect(u.content[0].text).toBe('/help');
    expect(a.role).toBe('assistant');
    expect(a._builtin?.command).toBe('help');
  });

  it('built-ins do not block subsequent built-in invocations', async () => {
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: '/help' }] });
    await adapter.prompt({ sessionId, prompt: [{ type: 'text', text: '/version' }] });
    const entries = await store.readEntries(sessionId);
    const builtinEntries = entries.filter(e => e.kind === 'builtin');
    expect(builtinEntries.map(e => (e.payload as { command: string }).command)).toEqual([
      'help',
      'version',
    ]);
  });

  it('/mcp add emits an mcp-add action via extNotification with the canonical URL params', async () => {
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    updates.length = 0;
    extNotifications.length = 0;
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/mcp add HTTPS://Mcp.Example.COM/path' }],
    });
    const chunk = updates.find(u => u.update.sessionUpdate === 'agent_message_chunk');
    const meta = chunk!._meta as { bodhi?: { builtin?: { command?: string } } } | null;
    expect(meta?.bodhi?.builtin?.command).toBe('mcp');
    const evt = extNotifications.find(n => n.method === '_bodhi/builtin/action');
    const params = evt!.params as {
      command?: string;
      action?: { kind?: string; params?: { url?: string } };
    };
    expect(params.command).toBe('mcp');
    expect(params.action?.kind).toBe('mcp-add');
    expect(params.action?.params?.url).toBe('https://mcp.example.com/path');
  });

  it('/mcp add of an already-requested URL emits no action extNotification and explains in transcript', async () => {
    const url = 'https://mcp.deepwiki.com/mcp';
    const { sessionId } = await adapter.newSession({
      cwd: '/',
      mcpServers: [],
      _meta: { bodhi: { requestedMcpUrls: [url] } },
    } as Parameters<typeof adapter.newSession>[0]);
    updates.length = 0;
    extNotifications.length = 0;
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: `/mcp add ${url}` }],
    });
    expect(extNotifications.find(n => n.method === '_bodhi/builtin/action')).toBeUndefined();
    const chunk = updates.find(u => u.update.sessionUpdate === 'agent_message_chunk');
    const text = (chunk!.update as { content?: { text?: string } }).content?.text ?? '';
    expect(text).toMatch(/already in your requested list/i);
  });

  it('/mcp remove of a URL not in the list emits no action extNotification', async () => {
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    updates.length = 0;
    extNotifications.length = 0;
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/mcp remove https://other.example/mcp' }],
    });
    expect(extNotifications.find(n => n.method === '_bodhi/builtin/action')).toBeUndefined();
    const chunk = updates.find(u => u.update.sessionUpdate === 'agent_message_chunk');
    const text = (chunk!.update as { content?: { text?: string } }).content?.text ?? '';
    expect(text).toMatch(/not in your requested list/i);
  });

  it('persists action.params on /mcp add so reload reproduces the tag', async () => {
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/mcp add https://mcp.example/x' }],
    });
    const entries = await store.readEntries(sessionId);
    const builtinEntries = entries.filter(e => e.kind === 'builtin');
    expect(builtinEntries).toHaveLength(1);
    const payload = builtinEntries[0].payload as {
      command: string;
      action?: { kind?: string; params?: { url?: string } };
    };
    expect(payload.command).toBe('mcp');
    expect(payload.action?.kind).toBe('mcp-add');
    expect(payload.action?.params?.url).toBe('https://mcp.example/x');
  });
});
