export { createMcpClient } from './client';
export type { CreateMcpClientResult } from './client';
export {
  McpConnectionPool,
  type McpAcquireResult,
  type McpPoolEvent,
  type McpPoolEventType,
  type McpPoolListener,
  type McpToolDescriptor,
} from './connection-pool';
export {
  createMcpAgentTool,
  mcpToolName,
  MCP_TOOL_NAME_SEPARATOR,
  type McpToolAdapterDeps,
  type McpToolDetails,
} from './tool-adapter';
