import { useState, useCallback, useEffect, useMemo } from 'react';
import type { Mcp, McpTool } from '@/lib/mcp-tools';
import { isMcpAvailable } from '@/lib/mcp-tools';

const STORAGE_KEY = 'bodhi-mcp-selection';

type EnabledMcpTools = Record<string, string[]>;

function loadSelection(): EnabledMcpTools {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function saveSelection(selection: EnabledMcpTools) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // silent fail
  }
}

export function useMcpSelection(mcps: Mcp[], toolsByMcpId: Record<string, McpTool[]>) {
  const [rawEnabledMcpTools, setEnabledMcpTools] = useState<EnabledMcpTools>(loadSelection);

  // Derive filtered selection, removing unavailable MCPs
  const enabledMcpTools = useMemo(() => {
    const availableIds = new Set(mcps.filter(isMcpAvailable).map(m => m.id));
    const filtered: EnabledMcpTools = {};
    let changed = false;
    for (const [id, tools] of Object.entries(rawEnabledMcpTools)) {
      if (availableIds.has(id)) {
        filtered[id] = tools;
      } else {
        changed = true;
      }
    }
    return changed ? filtered : rawEnabledMcpTools;
  }, [rawEnabledMcpTools, mcps]);

  useEffect(() => {
    saveSelection(enabledMcpTools);
  }, [enabledMcpTools]);

  const toggleTool = useCallback((mcpId: string, toolName: string) => {
    setEnabledMcpTools(prev => {
      const currentTools = prev[mcpId] || [];
      if (currentTools.includes(toolName)) {
        const newTools = currentTools.filter(name => name !== toolName);
        if (newTools.length === 0) {
          return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== mcpId));
        }
        return { ...prev, [mcpId]: newTools };
      } else {
        return { ...prev, [mcpId]: [...currentTools, toolName] };
      }
    });
  }, []);

  const toggleMcp = useCallback((mcpId: string, allToolNames: string[]) => {
    setEnabledMcpTools(prev => {
      const currentTools = prev[mcpId] || [];
      if (currentTools.length > 0) {
        return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== mcpId));
      } else {
        return { ...prev, [mcpId]: allToolNames };
      }
    });
  }, []);

  const getEnabledToolCount = useCallback(() => {
    return Object.values(enabledMcpTools).reduce((sum, tools) => sum + tools.length, 0);
  }, [enabledMcpTools]);

  const getCheckboxState = useCallback(
    (mcpId: string): 'checked' | 'unchecked' | 'indeterminate' => {
      const enabledCount = enabledMcpTools[mcpId]?.length || 0;
      if (enabledCount === 0) return 'unchecked';
      const totalTools = toolsByMcpId[mcpId]?.length ?? 0;
      if (enabledCount >= totalTools) return 'checked';
      return 'indeterminate';
    },
    [enabledMcpTools, toolsByMcpId]
  );

  return {
    enabledMcpTools,
    toggleTool,
    toggleMcp,
    getEnabledToolCount,
    getCheckboxState,
  };
}
