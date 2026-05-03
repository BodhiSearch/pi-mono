import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk';
import type { McpToggleSnapshot } from '@/mcp/compose-mcp-servers';
import type { McpConnectionMeta } from '@/mcp/types';

// Frozen empty sentinels — identity equality (`===`) is the contract so
// React bails out when a slice hasn't changed.

export const EMPTY_AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([]);

export const EMPTY_MCP_STATES: Record<string, McpConnectionMeta> = Object.freeze(
  {} as Record<string, McpConnectionMeta>
);

export const EMPTY_CONFIG_OPTIONS: readonly SessionConfigOption[] = Object.freeze([]);

export const EMPTY_MCP_TOGGLES: McpToggleSnapshot = Object.freeze({
  servers: Object.freeze({}) as Record<string, boolean>,
  tools: Object.freeze({}) as Record<string, Record<string, boolean>>,
}) as McpToggleSnapshot;
