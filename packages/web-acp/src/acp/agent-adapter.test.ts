import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { SessionStoreDb, createStoreFromDb, type SessionStore } from '@/agent/session-store';
import { McpConnectionPool } from '@/agent/mcp';
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
