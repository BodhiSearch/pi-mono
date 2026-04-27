import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentSideConnection,
  PromptRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { SessionStoreDb, createStoreFromDb, type SessionStore } from '@/agent/session-store';
import { McpConnectionPool } from '@/agent/mcp';
import type { CommandsFs, CommandsFsEntry } from '@/agent/commands';
import { createMcpToggleStore } from '@/mcp/toggle-store';
import { AcpAgentAdapter } from './agent-adapter';
import type { BodhiProvider } from '@/agent/bodhi-provider';
import type { InlineAgent } from '@/agent/inline-agent';
import {
  BODHI_GET_SESSION_METHOD,
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
  type BodhiGetSessionResponse,
  type BodhiMcpTogglesSetResponse,
  type BodhiSessionsDeleteResponse,
} from './index';

function fakeConn(): AgentSideConnection {
  return {
    sessionUpdate: vi.fn(async () => undefined),
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
      fakeInline(),
      fakeBodhi(),
      store,
      undefined,
      undefined,
      undefined,
      new McpConnectionPool(),
      toggles
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
    ).rejects.toThrow(/params must be/);
    await expect(
      adapter.extMethod(BODHI_MCP_TOGGLES_SET_METHOD, { sessionId: 's1', serverSlug: 'x' })
    ).rejects.toThrow(/params must be/);
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
      /params\.sessionId is required/
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
      ? (makeRegistry(opts.mounts) as unknown as ConstructorParameters<typeof AcpAgentAdapter>[4])
      : undefined;
    return new AcpAgentAdapter(
      conn,
      inline,
      fakeBodhi(),
      store,
      registry,
      undefined,
      undefined,
      new McpConnectionPool(),
      undefined,
      commandsFs
    );
  }

  it('emits an empty available_commands_update on newSession when no mounts are present', async () => {
    adapter = buildAdapter();
    await adapter.newSession({ cwd: '/', mcpServers: [] });
    const ac = updates.find(u => u.update.sessionUpdate === 'available_commands_update');
    expect(ac).toBeDefined();
    expect(ac && (ac.update as { availableCommands: unknown }).availableCommands).toEqual([]);
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
    expect(cmds).toEqual([
      { name: 'wiki:greet', description: 'Greet someone', input: { hint: '<name>' } },
    ]);
  });

  it('re-emits available_commands_update on loadSession', async () => {
    commandsFs.add('/mnt/wiki/.pi/commands/hello.md', '---\ndescription: hi\n---\nHi!');
    adapter = buildAdapter({ mounts: ['wiki'] });
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    updates.length = 0;
    await adapter.loadSession({ sessionId, cwd: '/', mcpServers: [] });
    const after = updates.filter(u => u.update.sessionUpdate === 'available_commands_update');
    // Loadsession replays the persisted notification AND re-emits a fresh one.
    expect(after.length).toBeGreaterThanOrEqual(1);
    const last = after[after.length - 1];
    const cmds = (last.update as { availableCommands: Array<{ name: string }> }).availableCommands;
    expect(cmds.map(c => c.name)).toEqual(['wiki:hello']);
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
    // Rebuild adapter with the populated bodhi provider.
    adapter = new AcpAgentAdapter(
      conn,
      inline,
      bodhi,
      store,
      makeRegistry(['wiki']) as unknown as ConstructorParameters<typeof AcpAgentAdapter>[4],
      undefined,
      undefined,
      new McpConnectionPool(),
      undefined,
      commandsFs
    );
    await adapter.extMethod('bodhi/listModels', {});
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    const req: PromptRequest = {
      sessionId,
      prompt: [{ type: 'text', text: '/wiki:greet alice paris' }],
      _meta: { bodhi: { modelId: 'test-model' } },
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
      inline,
      bodhi,
      store,
      makeRegistry(['wiki']) as unknown as ConstructorParameters<typeof AcpAgentAdapter>[4],
      undefined,
      undefined,
      new McpConnectionPool(),
      undefined,
      commandsFs
    );
    inline.prompt = vi.fn(async () => undefined);
    inline.getMessages = vi.fn(() => []);
    inline.getErrorMessage = vi.fn(() => undefined);
    inline.setModel = vi.fn();
    inline.subscribe = vi.fn(() => () => undefined);
    await adapter.extMethod('bodhi/listModels', {});
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'just a normal message' }],
      _meta: { bodhi: { modelId: 'test-model' } },
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
      inline,
      bodhi,
      store,
      makeRegistry(['wiki']) as unknown as ConstructorParameters<typeof AcpAgentAdapter>[4],
      undefined,
      undefined,
      new McpConnectionPool(),
      undefined,
      commandsFs
    );
    inline.prompt = vi.fn(async () => undefined);
    inline.getMessages = vi.fn(() => []);
    inline.getErrorMessage = vi.fn(() => undefined);
    inline.setModel = vi.fn();
    inline.subscribe = vi.fn(() => () => undefined);
    await adapter.extMethod('bodhi/listModels', {});
    const { sessionId } = await adapter.newSession({ cwd: '/', mcpServers: [] });
    await adapter.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/wiki:nope something' }],
      _meta: { bodhi: { modelId: 'test-model' } },
    });
    expect(inline.prompt).toHaveBeenCalledWith('/wiki:nope something');
  });
});
