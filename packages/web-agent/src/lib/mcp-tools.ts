const MCP_PREFIX = 'mcp__';
const SEPARATOR = '__';

export interface DecodedToolName {
  mcpSlug: string;
  toolName: string;
}

export function encodeMcpToolName(slug: string, toolName: string): string {
  return `${MCP_PREFIX}${slug}${SEPARATOR}${toolName}`;
}

export function decodeMcpToolName(encodedName: string): DecodedToolName | null {
  if (!encodedName.startsWith(MCP_PREFIX)) return null;
  const withoutPrefix = encodedName.slice(MCP_PREFIX.length);
  const separatorIndex = withoutPrefix.indexOf(SEPARATOR);
  if (separatorIndex === -1) return null;
  return {
    mcpSlug: withoutPrefix.slice(0, separatorIndex),
    toolName: withoutPrefix.slice(separatorIndex + SEPARATOR.length),
  };
}

export interface Mcp {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  path: string;
  mcp_server: {
    enabled: boolean;
  };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export function isMcpAvailable(mcp: Mcp): boolean {
  return mcp.mcp_server.enabled && mcp.enabled;
}

export function getUnavailableReason(mcp: Mcp): string | null {
  if (!mcp.mcp_server.enabled) return 'Disabled by administrator';
  if (!mcp.enabled) return 'Disabled by user';
  return null;
}
