/**
 * Compose `McpServerHttp[]` for `session/new` / `session/load`
 * requests. Mirrors `packages/web-acp/src/mcp/compose-mcp-servers.ts`
 * but accepts a CLI-shaped `McpInstanceView` (no React deps).
 *
 * The composed entries embed the current Bodhi access token as a
 * `Authorization: Bearer <token>` header on each server URL so the
 * agent worker can hand a ready-to-use `StreamableHTTPClientTransport`
 * to the MCP SDK without ever touching the token. When the token
 * rotates the CLI host re-issues `session/load` to rebuild the pool
 * with a fresh header — see `specs/web-acp-agent/mcp.md`.
 */

import type { McpServerHttp } from '@agentclientprotocol/sdk';
import type { McpToggleSnapshot } from '@bodhiapp/web-acp-agent';
import type { McpInstanceView } from './bodhi-client';

export function composeMcpServers(
  instances: McpInstanceView[],
  jwt: string,
  bodhiBaseUrl: string,
  toggles?: McpToggleSnapshot
): McpServerHttp[] {
  const base = bodhiBaseUrl.replace(/\/+$/, '');
  const out: McpServerHttp[] = [];
  for (const instance of instances) {
    if (!instance.enabled) continue;
    if (toggles && toggles.servers[instance.slug] === false) continue;
    const path = instance.path.startsWith('/') ? instance.path : `/${instance.path}`;
    out.push({
      name: instance.slug,
      url: `${base}${path}`,
      headers: [{ name: 'Authorization', value: `Bearer ${jwt}` }],
    });
  }
  return out;
}
