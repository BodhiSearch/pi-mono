import { useEffect } from 'react';
import { toast } from 'sonner';
import { useAgent } from '@/hooks/useAgent';
import { useMcpList } from '@/hooks/useMcpList';
import { useMcpSelection } from '@/hooks/useMcpSelection';
import { useMcpAgentTools } from '@/hooks/useMcpAgentTools';
import { SessionPicker } from '@/components/sessions/SessionPicker';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';

export default function ChatDemo() {
  const { mcps, toolsByMcpId, isLoading: isMcpsLoading } = useMcpList();
  const { enabledMcpTools, toggleTool, toggleMcp, getEnabledToolCount, getCheckboxState } =
    useMcpSelection(mcps, toolsByMcpId);

  const { descriptors: mcpToolDescriptors, handler: toolCallHandler } = useMcpAgentTools({
    enabledMcpTools,
    mcps,
    toolsByMcpId,
  });

  const {
    messages,
    streamingMessage,
    isStreaming,
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
  } = useAgent({ mcpToolDescriptors, toolCallHandler });

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
      />
    </>
  );
}
