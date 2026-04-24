import type { McpServerHttp } from '@agentclientprotocol/sdk';
import type { McpInstanceView } from './types';

/**
 * Per-session MCP toggle overrides. `servers[slug] === false` strips
 * the server from the composed `mcpServers` array (Phase B); per-tool
 * filtering is applied worker-side after `tools/list` because the
 * catalog is not known on the main thread.
 */
export interface McpToggleSnapshot {
  servers: Record<string, boolean>;
  tools: Record<string, Record<string, boolean>>;
}

/**
 * Compose the `mcpServers` argument for `session/new` /
 * `session/load`. We embed the current JWT as an
 * `Authorization: Bearer <jwt>` header on every server entry so the
 * worker can hand a ready-to-use `StreamableHTTPClientTransport` to
 * the MCP SDK without ever touching the token itself. When the token
 * rotates the main thread re-issues `session/load` to rebuild the
 * pool with a fresh header — see `mcp.md` for the decision log.
 */
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
