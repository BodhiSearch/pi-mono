/**
 * Build the `_meta.bodhi` payload stamped onto every `session/new` /
 * `session/load` request. Mirrors
 * `packages/web-acp/src/acp/session-meta.ts`. Pure function.
 *
 * `requestedMcpUrls` comes from sqlite kv (the user's "I want Bodhi
 * to approve these MCP URLs" list, persisted across launches).
 * `instances` comes from the live Bodhi catalog fetch. Both inputs
 * may be empty for vanilla sessions, in which case we return
 * `undefined` so the wire frame stays compact.
 */

import type { BodhiMcpInstanceDescriptor, BodhiSessionMeta } from '@bodhiapp/web-acp-agent';
import type { McpInstanceView } from './bodhi-client';

export function authKeyOf(token: string, baseUrl: string): string {
  return `${baseUrl}::${token}`;
}

export function composeSessionMeta(
  requestedMcpUrls: string[],
  instances: McpInstanceView[]
): BodhiSessionMeta | undefined {
  const mcpInstances: BodhiMcpInstanceDescriptor[] = instances.map(i => ({
    slug: i.slug,
    name: i.name,
    path: i.path,
  }));
  if (requestedMcpUrls.length === 0 && mcpInstances.length === 0) return undefined;
  return { requestedMcpUrls: [...requestedMcpUrls], mcpInstances };
}
