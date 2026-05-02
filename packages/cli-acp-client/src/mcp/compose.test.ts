import { describe, expect, it } from 'vitest';
import { composeMcpServers } from './compose';
import type { McpInstanceView } from './bodhi-client';

function instance(overrides: Partial<McpInstanceView> = {}): McpInstanceView {
  return {
    id: 'id',
    slug: 'slug',
    name: 'name',
    description: null,
    enabled: true,
    path: '/bodhi/v1/apps/mcps/x/mcp',
    authType: 'header',
    ...overrides,
  };
}

describe('composeMcpServers', () => {
  it('builds an authorized HTTP server entry for each enabled instance', () => {
    const out = composeMcpServers(
      [instance({ slug: 'alpha' }), instance({ slug: 'beta' })],
      'tok',
      'https://bodhi.example.com'
    );
    expect(out).toEqual([
      {
        name: 'alpha',
        url: 'https://bodhi.example.com/bodhi/v1/apps/mcps/x/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer tok' }],
      },
      {
        name: 'beta',
        url: 'https://bodhi.example.com/bodhi/v1/apps/mcps/x/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer tok' }],
      },
    ]);
  });

  it('strips servers disabled by per-server toggle', () => {
    const out = composeMcpServers(
      [instance({ slug: 'alpha' }), instance({ slug: 'beta' })],
      'tok',
      'https://bodhi.example.com',
      { servers: { alpha: false }, tools: {} }
    );
    expect(out.map(s => s.name)).toEqual(['beta']);
  });

  it('strips disabled instances', () => {
    const out = composeMcpServers(
      [instance({ enabled: false })],
      'tok',
      'https://bodhi.example.com'
    );
    expect(out).toEqual([]);
  });
});
