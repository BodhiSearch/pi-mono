import { describe, expect, it, vi } from 'vitest';
import { listMcpInstances } from './bodhi-client';

describe('listMcpInstances', () => {
  it('calls GET /bodhi/v1/apps/mcps with the bearer token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        mcps: [
          {
            id: 'id-1',
            slug: 'deepwiki',
            name: 'DeepWiki',
            description: null,
            enabled: true,
            path: '/bodhi/v1/apps/mcps/id-1/mcp',
            auth_type: 'header',
          },
        ],
      }),
    })) as unknown as typeof fetch;
    const out = await listMcpInstances({
      baseUrl: 'https://bodhi.example.com',
      token: 'TOKEN',
      fetch: fetchMock,
    });
    expect(out).toEqual([
      {
        id: 'id-1',
        slug: 'deepwiki',
        name: 'DeepWiki',
        description: null,
        enabled: true,
        path: '/bodhi/v1/apps/mcps/id-1/mcp',
        authType: 'header',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bodhi.example.com/bodhi/v1/apps/mcps',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer TOKEN' }),
      })
    );
  });

  it('supports a bare-array response shape', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          id: 'id-1',
          slug: 'fast',
          name: 'Fast',
          enabled: true,
          path: '/bodhi/v1/apps/mcps/id-1/mcp',
          auth_type: 'public',
        },
      ],
    })) as unknown as typeof fetch;
    const out = await listMcpInstances({
      baseUrl: 'https://bodhi.example.com/',
      token: 'TOK',
      fetch: fetchMock,
    });
    expect(out).toHaveLength(1);
    expect(out[0].slug).toBe('fast');
  });

  it('throws with body context on non-200 responses', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'missing token',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      listMcpInstances({
        baseUrl: 'https://bodhi.example.com',
        token: 'BAD',
        fetch: fetchMock,
      })
    ).rejects.toThrow(/401.*Unauthorized.*missing token/i);
  });
});
