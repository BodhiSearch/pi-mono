import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import { createMcpClient } from '@bodhiapp/bodhi-js-react/mcp';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  decodeMcpToolName,
  encodeMcpToolName,
  isMcpAvailable,
  type Mcp,
  type McpTool,
} from '@/lib/mcp-tools';
import type { McpToolDescriptor, ToolCallHandler } from '@/web-agent';

interface UseMcpAgentToolsInput {
  enabledMcpTools: Record<string, string[]>;
  mcps: Mcp[];
  toolsByMcpId: Record<string, McpTool[]>;
}

interface UseMcpAgentToolsResult {
  /** Plain-data descriptors shipped to the Worker. */
  descriptors: McpToolDescriptor[];
  /** Handler invoked when the Worker upcalls a tool. */
  handler: ToolCallHandler;
}

const NOOP_HANDLER: ToolCallHandler = async toolName => {
  throw new Error(`MCP tool "${toolName}" is not registered`);
};

export function useMcpAgentTools({
  enabledMcpTools,
  mcps,
  toolsByMcpId,
}: UseMcpAgentToolsInput): UseMcpAgentToolsResult {
  const { client } = useBodhi();
  const [clientsCache] = useState<Map<string, Client>>(() => new Map());

  const mcpBySlug = useMemo(() => {
    const map = new Map<string, Mcp>();
    for (const mcp of mcps) map.set(mcp.slug, mcp);
    return map;
  }, [mcps]);

  useEffect(() => {
    return () => {
      for (const c of clientsCache.values()) {
        c.close().catch(() => {});
      }
      clientsCache.clear();
    };
  }, [clientsCache]);

  const descriptors = useMemo<McpToolDescriptor[]>(() => {
    const out: McpToolDescriptor[] = [];
    for (const [mcpId, enabledToolNames] of Object.entries(enabledMcpTools)) {
      if (enabledToolNames.length === 0) continue;
      const mcp = mcps.find(m => m.id === mcpId);
      if (!mcp || !isMcpAvailable(mcp)) continue;

      const mcpTools = toolsByMcpId[mcpId] ?? [];
      for (const mcpTool of mcpTools) {
        if (!enabledToolNames.includes(mcpTool.name)) continue;
        const encodedName = encodeMcpToolName(mcp.slug, mcpTool.name);
        out.push({
          name: encodedName,
          description: mcpTool.description ?? '',
          parameters: mcpTool.inputSchema ?? {},
        });
      }
    }
    return out;
  }, [enabledMcpTools, mcps, toolsByMcpId]);

  const handler = useCallback<ToolCallHandler>(
    async (toolName, args) => {
      const decoded = decodeMcpToolName(toolName);
      if (!decoded) throw new Error(`Failed to decode tool name: ${toolName}`);

      const target = mcpBySlug.get(decoded.mcpSlug);
      if (!target) throw new Error(`Unknown MCP slug: ${decoded.mcpSlug}`);

      let mcpClient = clientsCache.get(decoded.mcpSlug);
      if (!mcpClient) {
        mcpClient = await createMcpClient(client, target.path);
        clientsCache.set(decoded.mcpSlug, mcpClient);
      }

      const result = await mcpClient.callTool({
        name: decoded.toolName,
        arguments: (args ?? {}) as Record<string, unknown>,
      });

      if (result.isError) {
        const text =
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
        throw new Error(text);
      }

      const text =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);

      return {
        content: [{ type: 'text', text }],
        details: result.content,
      };
    },
    [mcpBySlug, client, clientsCache]
  );

  // Always return a non-null handler — even when there are no descriptors,
  // the Worker may still upcall if MCP tools are registered later.
  return {
    descriptors,
    handler: descriptors.length > 0 ? handler : NOOP_HANDLER,
  };
}
