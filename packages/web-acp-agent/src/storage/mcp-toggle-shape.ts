export interface McpToggleSnapshot {
  servers: Record<string, boolean>;
  tools: Record<string, Record<string, boolean>>;
}

export const EMPTY_MCP_TOGGLES: McpToggleSnapshot = Object.freeze({
  servers: Object.freeze({}) as Record<string, boolean>,
  tools: Object.freeze({}) as Record<string, Record<string, boolean>>,
}) as McpToggleSnapshot;

export function isServerEnabled(
  toggles: McpToggleSnapshot | undefined,
  serverSlug: string
): boolean {
  if (!toggles) return true;
  const explicit = toggles.servers?.[serverSlug];
  return explicit !== false;
}

export function isToolEnabled(
  toggles: McpToggleSnapshot | undefined,
  serverSlug: string,
  toolName: string
): boolean {
  if (!toggles) return true;
  if (!isServerEnabled(toggles, serverSlug)) return false;
  const perServer = toggles.tools?.[serverSlug];
  if (!perServer) return true;
  return perServer[toolName] !== false;
}

export function isMcpToggleSnapshot(value: unknown): value is McpToggleSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.servers === 'object' && typeof v.tools === 'object';
}
