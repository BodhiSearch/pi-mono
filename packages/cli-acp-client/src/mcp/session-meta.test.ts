import { describe, expect, it } from 'vitest';
import { authKeyOf, composeSessionMeta } from './session-meta';
import type { McpInstanceView } from './bodhi-client';

const wiki: McpInstanceView = {
  id: 'i-1',
  slug: 'wiki',
  name: 'Wiki',
  description: null,
  enabled: true,
  path: '/bodhi/v1/apps/mcps/i-1/mcp',
  authType: 'oauth',
};

describe('composeSessionMeta', () => {
  it('returns undefined for empty inputs', () => {
    expect(composeSessionMeta([], [])).toBeUndefined();
  });

  it.each([
    [
      ['https://x.example/mcp'],
      [],
      { requestedMcpUrls: ['https://x.example/mcp'], mcpInstances: [] },
    ],
    [
      [],
      [wiki],
      {
        requestedMcpUrls: [],
        mcpInstances: [{ slug: 'wiki', name: 'Wiki', path: '/bodhi/v1/apps/mcps/i-1/mcp' }],
      },
    ],
    [
      ['https://x.example/mcp'],
      [wiki],
      {
        requestedMcpUrls: ['https://x.example/mcp'],
        mcpInstances: [{ slug: 'wiki', name: 'Wiki', path: '/bodhi/v1/apps/mcps/i-1/mcp' }],
      },
    ],
  ])('emits %j + %j → %j', (urls, instances, expected) => {
    expect(composeSessionMeta(urls as string[], instances as McpInstanceView[])).toEqual(expected);
  });

  it('strips fields outside (slug,name,path) from the descriptor', () => {
    const meta = composeSessionMeta([], [{ ...wiki, description: 'noisy', authType: 'header' }]);
    const desc = meta?.mcpInstances[0] as Record<string, unknown>;
    expect(Object.keys(desc).sort()).toEqual(['name', 'path', 'slug']);
  });

  it('returns a copy of requestedMcpUrls (caller mutation cannot leak)', () => {
    const input = ['a', 'b'];
    const meta = composeSessionMeta(input, []);
    input.push('c');
    expect(meta?.requestedMcpUrls).toEqual(['a', 'b']);
  });
});

describe('authKeyOf', () => {
  // Signature: authKeyOf(token, baseUrl). Output: `${baseUrl}::${token}`.
  // The URL-first key shape lets `useAcpAuth`-style code prefix-scan a
  // map of pending auth promises by host.
  it.each([
    ['tkn1', 'https://bodhi.local', 'https://bodhi.local::tkn1'],
    ['', '', '::'],
    ['a:b:c', 'https://x', 'https://x::a:b:c'],
  ])('authKeyOf(%j, %j) === %j', (token, baseUrl, expected) => {
    expect(authKeyOf(token, baseUrl)).toBe(expected);
  });

  it('produces distinct keys for distinct (token, baseUrl) pairs', () => {
    const a = authKeyOf('t1', 'https://h1');
    const b = authKeyOf('t1', 'https://h2');
    const c = authKeyOf('t2', 'https://h1');
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
