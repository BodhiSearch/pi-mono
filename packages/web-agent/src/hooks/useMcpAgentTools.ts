import { useEffect, useMemo, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import { createMcpClient } from '@bodhiapp/bodhi-js-react/mcp';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  decodeMcpToolName,
  encodeMcpToolName,
  isMcpAvailable,
  type Mcp,
  type McpTool,
} from '@/lib/mcp-tools';

interface UseMcpAgentToolsInput {
  enabledMcpTools: Record<string, string[]>;
  mcps: Mcp[];
  toolsByMcpId: Record<string, McpTool[]>;
}

export function useMcpAgentTools({
  enabledMcpTools,
  mcps,
  toolsByMcpId,
}: UseMcpAgentToolsInput): AgentTool[] {
  const { client } = useBodhi();
  // useState (not useRef) to hold this mutable cache: refs captured by
  // closures created during render trip react-hooks/refs.
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

  return useMemo(() => {
    const tools: AgentTool[] = [];

    for (const [mcpId, enabledToolNames] of Object.entries(enabledMcpTools)) {
      if (enabledToolNames.length === 0) continue;
      const mcp = mcps.find(m => m.id === mcpId);
      if (!mcp || !isMcpAvailable(mcp)) continue;

      const mcpTools = toolsByMcpId[mcpId] ?? [];
      for (const mcpTool of mcpTools) {
        if (!enabledToolNames.includes(mcpTool.name)) continue;

        const encodedName = encodeMcpToolName(mcp.slug, mcpTool.name);

        tools.push({
          name: encodedName,
          label: mcpTool.name,
          description: mcpTool.description ?? '',
          parameters: Type.Unsafe(mcpTool.inputSchema ?? {}),
          execute: async (
            _toolCallId: string,
            params: unknown
          ): Promise<AgentToolResult<unknown>> => {
            const decoded = decodeMcpToolName(encodedName);
            if (!decoded) throw new Error(`Failed to decode tool name: ${encodedName}`);

            const target = mcpBySlug.get(decoded.mcpSlug);
            if (!target) throw new Error(`Unknown MCP slug: ${decoded.mcpSlug}`);

            let mcpClient = clientsCache.get(decoded.mcpSlug);
            if (!mcpClient) {
              mcpClient = await createMcpClient(client, target.path);
              clientsCache.set(decoded.mcpSlug, mcpClient);
            }

            const result = await mcpClient.callTool({
              name: decoded.toolName,
              arguments: (params ?? {}) as Record<string, unknown>,
            });

            if (result.isError) {
              const text =
                typeof result.content === 'string'
                  ? result.content
                  : JSON.stringify(result.content);
              throw new Error(text);
            }

            const text =
              typeof result.content === 'string' ? result.content : JSON.stringify(result.content);

            return {
              content: [{ type: 'text', text }],
              details: result.content,
            };
          },
        });
      }
    }

    return tools;
  }, [enabledMcpTools, mcps, toolsByMcpId, mcpBySlug, client, clientsCache]);
}
