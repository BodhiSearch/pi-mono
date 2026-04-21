import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useAgent } from '@/hooks/useAgent';
import { useMcpList } from '@/hooks/useMcpList';
import { useMcpSelection } from '@/hooks/useMcpSelection';
import { useMcpAgentTools } from '@/hooks/useMcpAgentTools';
import { useSkillSandbox } from '@/hooks/useSkillSandbox';
import { SessionPicker } from '@/components/sessions/SessionPicker';
import type { McpToolDescriptor, ToolCallHandler } from '@/worker-agent';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';

export default function ChatDemo() {
  const { mcps, toolsByMcpId, isLoading: isMcpsLoading } = useMcpList();
  const { enabledMcpTools, toggleTool, toggleMcp, getEnabledToolCount, getCheckboxState } =
    useMcpSelection(mcps, toolsByMcpId);

  const { descriptors: mcpDescriptors, handler: mcpHandler } = useMcpAgentTools({
    enabledMcpTools,
    mcps,
    toolsByMcpId,
  });

  const { descriptor: skillDescriptor, handler: skillHandler } = useSkillSandbox();

  // Merge MCP tools with the bash-skill shim so the worker sees one
  // flat tool list. The handler dispatches by tool name — skills go
  // to the sandbox, everything else falls through to MCP.
  const mcpToolDescriptors = useMemo<McpToolDescriptor[]>(
    () => [skillDescriptor, ...mcpDescriptors],
    [skillDescriptor, mcpDescriptors]
  );
  const toolCallHandler = useMemo<ToolCallHandler>(() => {
    return async (toolName, args) => {
      if (toolName === skillDescriptor.name) {
        return skillHandler(toolName, args);
      }
      return mcpHandler(toolName, args);
    };
  }, [skillDescriptor, skillHandler, mcpHandler]);

  const {
    messages,
    streamingMessage,
    isStreaming,
    isCompacting,
    selectedModel,
    setSelectedModel,
    sendMessage,
    clearMessages,
    error: chatError,
    clearError: clearChatError,
    models,
    isLoadingModels,
    loadModels,
    sessions,
    transientMessages,
  } = useAgent({
    mcpToolDescriptors,
    toolCallHandler,
  });

  useEffect(() => {
    if (chatError) {
      toast.error(chatError, {
        onDismiss: clearChatError,
        onAutoClose: clearChatError,
      });
    }
  }, [chatError, clearChatError]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Chat
        </span>
        <SessionPicker
          current={sessions.current}
          list={sessions.list}
          onSwitch={sessions.load}
          onNew={sessions.newSession}
          onDelete={sessions.delete}
          onRename={sessions.rename}
        />
      </div>
      <ChatMessages
        messages={messages}
        streamingMessage={streamingMessage}
        isStreaming={isStreaming}
        error={chatError}
        messageMeta={sessions.messageMeta}
        transientMessages={transientMessages}
        onForkFromEntry={entryId => {
          void sessions.fork(entryId);
        }}
        onBranchFromEntry={entryId => {
          void sessions.navigateToLeaf(entryId);
        }}
      />
      <ChatInput
        onSendMessage={sendMessage}
        onClearMessages={clearMessages}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        models={models}
        isLoadingModels={isLoadingModels}
        onRefreshModels={loadModels}
        mcps={mcps}
        toolsByMcpId={toolsByMcpId}
        enabledMcpTools={enabledMcpTools}
        onToggleMcp={toggleMcp}
        onToggleTool={toggleTool}
        getCheckboxState={getCheckboxState}
        enabledToolCount={getEnabledToolCount()}
        isMcpsLoading={isMcpsLoading}
        isCompacting={isCompacting}
        isStreaming={isStreaming}
        onCompactNow={() => void sessions.compactNow()}
      />
    </>
  );
}
