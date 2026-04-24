import { describe, expect, it } from 'vitest';
import { composeMcpServers } from './compose-mcp-servers';
import type { McpInstanceView } from './types';

function instance(
  overrides: Partial<McpInstanceView> & Pick<McpInstanceView, 'slug' | 'path'>
): McpInstanceView {
  return {
    id: overrides.id ?? `id-${overrides.slug}`,
    slug: overrides.slug,
    name: overrides.name ?? overrides.slug,
    description: overrides.description ?? null,
    enabled: overrides.enabled ?? true,
    path: overrides.path,
    authType: overrides.authType ?? 'public',
  };
}

describe('composeMcpServers', () => {
  const baseUrl = 'http://localhost:1135';
  const jwt = 'test-jwt';

  it('composes one McpServerHttp per enabled instance with the Bearer header', () => {
    const instances = [
      instance({ slug: 'alpha', path: '/bodhi/v1/apps/mcps/alpha-id/mcp' }),
      instance({ slug: 'beta', path: '/bodhi/v1/apps/mcps/beta-id/mcp' }),
    ];
    const out = composeMcpServers(instances, jwt, baseUrl);
    expect(out).toEqual([
      {
        name: 'alpha',
        url: 'http://localhost:1135/bodhi/v1/apps/mcps/alpha-id/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer test-jwt' }],
      },
      {
        name: 'beta',
        url: 'http://localhost:1135/bodhi/v1/apps/mcps/beta-id/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer test-jwt' }],
      },
    ]);
  });

  it('drops disabled instances', () => {
    const instances = [
      instance({ slug: 'alpha', path: '/p1', enabled: false }),
      instance({ slug: 'beta', path: '/p2' }),
    ];
    const out = composeMcpServers(instances, jwt, baseUrl);
    expect(out.map(s => s.name)).toEqual(['beta']);
  });

  it('respects server-level toggles', () => {
    const instances = [
      instance({ slug: 'alpha', path: '/p1' }),
      instance({ slug: 'beta', path: '/p2' }),
    ];
    const out = composeMcpServers(instances, jwt, baseUrl, {
      servers: { alpha: false, beta: true },
      tools: {},
    });
    expect(out.map(s => s.name)).toEqual(['beta']);
  });

  it('normalises base URL and path separators', () => {
    const instances = [instance({ slug: 'alpha', path: 'apps/mcps/x/mcp' })];
    const out = composeMcpServers(instances, jwt, 'http://localhost:1135/');
    expect(out[0].url).toBe('http://localhost:1135/apps/mcps/x/mcp');
  });
});
