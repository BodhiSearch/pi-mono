import { useState } from 'react';
import { Plug, ChevronRight, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type Mcp, type McpTool, isMcpAvailable, getUnavailableReason } from '@/lib/mcp-tools';

interface McpItemProps {
  mcp: Mcp;
  tools: McpTool[];
  isExpanded: boolean;
  onToggleExpand: () => void;
  enabledTools: string[];
  checkboxState: 'checked' | 'unchecked' | 'indeterminate';
  onToggleMcp: (mcpId: string, allToolNames: string[]) => void;
  onToggleTool: (mcpId: string, toolName: string) => void;
}

function McpItem({
  mcp,
  tools,
  isExpanded,
  onToggleExpand,
  enabledTools,
  checkboxState,
  onToggleMcp,
  onToggleTool,
}: McpItemProps) {
  const isAvailable = isMcpAvailable(mcp);
  const unavailableReason = getUnavailableReason(mcp);
  const visibleTools = tools;
  const enabledCount = enabledTools.length;

  const content = (
    <div data-testid={`mcp-row-${mcp.id}`} className={!isAvailable ? 'opacity-50' : undefined}>
      <div className="flex items-center space-x-2 rounded-md p-2 hover:bg-accent">
        <button
          data-testid={`mcp-expand-${mcp.id}`}
          className="p-0 h-4 w-4 flex items-center justify-center"
          onClick={e => {
            e.stopPropagation();
            if (isAvailable) onToggleExpand();
          }}
          disabled={!isAvailable}
        >
          {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>

        <Checkbox
          data-testid={`mcp-checkbox-${mcp.id}`}
          id={`mcp-${mcp.id}`}
          checked={
            checkboxState === 'checked'
              ? true
              : checkboxState === 'indeterminate'
                ? 'indeterminate'
                : false
          }
          onCheckedChange={() =>
            onToggleMcp(
              mcp.id,
              visibleTools.map(t => t.name)
            )
          }
          disabled={!isAvailable}
        />

        <label htmlFor={`mcp-${mcp.id}`} className="text-sm cursor-pointer flex-1">
          {mcp.slug}
        </label>

        <span className="text-xs text-muted-foreground">
          ({enabledCount}/{visibleTools.length})
        </span>
      </div>

      {isExpanded && isAvailable && (
        <div className="ml-6 space-y-1 mt-1">
          {visibleTools.map(tool => (
            <div
              key={tool.name}
              data-testid={`mcp-tool-row-${mcp.id}-${tool.name}`}
              className="flex items-center space-x-2 rounded-md p-1.5 hover:bg-accent"
            >
              <Checkbox
                data-testid={`mcp-tool-checkbox-${mcp.id}-${tool.name}`}
                id={`mcp-tool-${mcp.id}-${tool.name}`}
                checked={enabledTools.includes(tool.name)}
                onCheckedChange={() => onToggleTool(mcp.id, tool.name)}
              />
              <label htmlFor={`mcp-tool-${mcp.id}-${tool.name}`} className="text-xs cursor-pointer">
                {tool.name}
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (!isAvailable && unavailableReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent>{unavailableReason}</TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

interface McpPopoverProps {
  mcps: Mcp[];
  toolsByMcpId: Record<string, McpTool[]>;
  enabledMcpTools: Record<string, string[]>;
  onToggleMcp: (mcpId: string, allToolNames: string[]) => void;
  onToggleTool: (mcpId: string, toolName: string) => void;
  getCheckboxState: (mcpId: string) => 'checked' | 'unchecked' | 'indeterminate';
  enabledToolCount: number;
  isLoading: boolean;
}

export default function McpPopover({
  mcps,
  toolsByMcpId,
  enabledMcpTools,
  onToggleMcp,
  onToggleTool,
  getCheckboxState,
  enabledToolCount,
  isLoading,
}: McpPopoverProps) {
  const [expandedMcps, setExpandedMcps] = useState<Set<string>>(new Set());

  const toggleExpand = (mcpId: string) => {
    setExpandedMcps(prev => {
      const next = new Set(prev);
      if (next.has(mcpId)) {
        next.delete(mcpId);
      } else {
        next.add(mcpId);
      }
      return next;
    });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-testid="mcps-popover-trigger"
          variant="ghost"
          size="icon"
          className="relative"
          title="MCP Servers"
        >
          <Plug className="size-4" />
          {enabledToolCount > 0 && (
            <span
              data-testid="mcps-badge"
              className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] bg-blue-500 text-white rounded-full flex items-center justify-center"
            >
              {enabledToolCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="mcps-popover-content"
        className="w-80 p-2"
        align="start"
        side="top"
      >
        {isLoading ? (
          <p className="text-sm text-muted-foreground p-2">Loading MCP servers...</p>
        ) : mcps.length === 0 ? (
          <p data-testid="mcps-empty-state" className="text-sm text-muted-foreground p-2">
            No MCP servers available
          </p>
        ) : (
          <div className="space-y-1">
            {mcps.map(mcp => (
              <McpItem
                key={mcp.id}
                mcp={mcp}
                tools={toolsByMcpId[mcp.id] ?? []}
                isExpanded={expandedMcps.has(mcp.id)}
                onToggleExpand={() => toggleExpand(mcp.id)}
                enabledTools={enabledMcpTools[mcp.id] ?? []}
                checkboxState={getCheckboxState(mcp.id)}
                onToggleMcp={onToggleMcp}
                onToggleTool={onToggleTool}
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
