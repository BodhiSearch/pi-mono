import type { McpServerHttp } from '@agentclientprotocol/sdk';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpConnectionPool, type McpPoolEvent } from './connection-pool';

interface FakeClient {
  listTools: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const createMcpClientMock = vi.fn();
vi.mock('./client', () => ({
  createMcpClient: (...args: unknown[]) => createMcpClientMock(...args),
}));

function fakeClient(tools: Array<{ name: string; description?: string }>): FakeClient {
  return {
    listTools: vi.fn(async () => ({
      tools: tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: { type: 'object' as const, properties: {} },
      })),
    })),
    close: vi.fn(async () => undefined),
  };
}

function serverConfig(name: string, url: string, token: string = 'jwt-v1'): McpServerHttp {
  return {
    name,
    url,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
  };
}

function createResult(client: FakeClient) {
  return {
    client: client as unknown as Client,
    close: client.close,
  };
}

describe('McpConnectionPool', () => {
  beforeEach(() => {
    createMcpClientMock.mockReset();
  });

  it('connects once per URL and shares the client across sessions', async () => {
    const client = fakeClient([{ name: 'echo' }]);
    createMcpClientMock.mockResolvedValue(createResult(client));

    const pool = new McpConnectionPool();
    const cfg = serverConfig('everything', 'https://example/mcps/ev/mcp');
    const events: McpPoolEvent[] = [];
    pool.subscribe(e => events.push(e));

    const r1 = await pool.acquire('s1', cfg);
    const r2 = await pool.acquire('s2', cfg);

    expect(createMcpClientMock).toHaveBeenCalledTimes(1);
    expect(r1.client).toBe(r2.client);
    expect(r1.tools.map(t => t.name)).toEqual(['echo']);
    expect(pool.size()).toBe(1);
    expect(events.map(e => e.type)).toEqual(['connecting', 'connected']);
  });

  it('closes the client once the last session releases it', async () => {
    const client = fakeClient([{ name: 'echo' }]);
    createMcpClientMock.mockResolvedValue(createResult(client));

    const pool = new McpConnectionPool();
    const cfg = serverConfig('everything', 'https://example/mcps/ev/mcp');
    await pool.acquire('s1', cfg);
    await pool.acquire('s2', cfg);
    await pool.release('s1', cfg);
    expect(client.close).not.toHaveBeenCalled();
    await pool.release('s2', cfg);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(pool.size()).toBe(0);
  });

  it('evicts and reconnects when the auth fingerprint changes', async () => {
    const first = fakeClient([{ name: 'echo' }]);
    const second = fakeClient([{ name: 'echo' }, { name: 'add' }]);
    createMcpClientMock
      .mockResolvedValueOnce(createResult(first))
      .mockResolvedValueOnce(createResult(second));

    const pool = new McpConnectionPool();
    const cfgV1 = serverConfig('everything', 'https://example/mcps/ev/mcp', 'jwt-v1');
    const cfgV2 = serverConfig('everything', 'https://example/mcps/ev/mcp', 'jwt-v2');

    await pool.acquire('s1', cfgV1);
    const after = await pool.acquire('s1', cfgV2);

    expect(createMcpClientMock).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(after.tools.map(t => t.name)).toEqual(['echo', 'add']);
  });

  it('emits an error event and rethrows when connect fails', async () => {
    const boom = new Error('transport down');
    createMcpClientMock.mockRejectedValue(boom);

    const pool = new McpConnectionPool();
    const events: McpPoolEvent[] = [];
    pool.subscribe(e => events.push(e));

    await expect(
      pool.acquire('s1', serverConfig('everything', 'https://example/mcps/ev/mcp'))
    ).rejects.toBe(boom);
    expect(events.map(e => e.type)).toEqual(['connecting', 'error']);
    expect(events.at(-1)?.error).toBe('transport down');
  });

  it('releaseAll drops every hold a session has', async () => {
    const a = fakeClient([{ name: 'a' }]);
    const b = fakeClient([{ name: 'b' }]);
    createMcpClientMock
      .mockResolvedValueOnce(createResult(a))
      .mockResolvedValueOnce(createResult(b));

    const pool = new McpConnectionPool();
    const cfgA = serverConfig('a', 'https://example/mcps/a/mcp');
    const cfgB = serverConfig('b', 'https://example/mcps/b/mcp');
    await pool.acquire('s1', cfgA);
    await pool.acquire('s1', cfgB);
    await pool.releaseAll('s1');
    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
    expect(pool.size()).toBe(0);
  });

  it('evictBySlug closes pool entries regardless of refcount (Phase 7)', async () => {
    const a = fakeClient([{ name: 'a' }]);
    const b = fakeClient([{ name: 'b' }]);
    createMcpClientMock
      .mockResolvedValueOnce(createResult(a))
      .mockResolvedValueOnce(createResult(b));

    const pool = new McpConnectionPool();
    const cfgA = serverConfig('a', 'https://example/mcps/a/mcp');
    const cfgB = serverConfig('b', 'https://other/mcps/b/mcp');
    // Two sessions hold the same pool entry so the refcount stays
    // ≥1 after a normal `release`; `evictBySlug` must override that.
    await pool.acquire('s1', cfgA);
    await pool.acquire('s2', cfgA);
    await pool.acquire('s1', cfgB);
    expect(pool.size()).toBe(2);

    const events: McpPoolEvent[] = [];
    pool.subscribe(e => events.push(e));

    // Slug `example` (host's most-distinctive label) matches cfgA only.
    await pool.evictBySlug('example', url => new URL(url).hostname.split('.')[0]);

    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).not.toHaveBeenCalled();
    expect(pool.size()).toBe(1);
    expect(events.some(e => e.type === 'disconnected' && e.url === cfgA.url)).toBe(true);
  });
});
