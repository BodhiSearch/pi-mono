import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';
import type {
  BodhiMcpInstanceDescriptor,
  BodhiModelDescriptor,
  BodhiSessionMeta,
} from '@/acp/index';
import type { BodhiModelInfo } from '@/lib/bodhi-models';
import type { McpInstanceView } from '@/mcp/types';

export function authKeyOf(token: string, baseUrl: string): string {
  return `${baseUrl}::${token}`;
}

export function toBodhiModelInfo(model: BodhiModelDescriptor): BodhiModelInfo {
  return { id: model.id, apiFormat: model.apiFormat as ApiFormat };
}

/**
 * Build the per-session `BodhiSessionMeta` payload from the current
 * IDB list and approved-instance catalog. Pure — kept at module
 * scope so the React Compiler doesn't flag it as un-memoizable
 * useCallback noise. Returns `undefined` when both inputs are empty
 * so the wire frame stays compact for vanilla sessions.
 */
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
