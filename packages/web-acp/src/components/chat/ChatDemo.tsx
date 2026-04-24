import { useEffect } from 'react';
import { toast } from 'sonner';
import { useAcp } from '@/hooks/useAcp';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import SessionPicker from './SessionPicker';
import VolumesPanel from '@/components/volumes/VolumesPanel';
import FeaturePanel from '@/components/features/FeaturePanel';
import McpPanel from '@/mcp/McpPanel';

export default function ChatDemo() {
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
    loadSession,
    currentSessionId,
    volumes,
    features,
    featureDefaults,
    setFeature,
    toolCalls,
    mcp,
  } = useAcp();

  useEffect(() => {
    if (chatError) {
      toast.error(chatError, {
        onDismiss: clearChatError,
        onAutoClose: clearChatError,
      });
    }
  }, [chatError, clearChatError]);

  const handleSelectSession = (id: string) => {
    if (id === currentSessionId) return;
    void loadSession(id);
  };

  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex flex-col w-64 shrink-0 border-r overflow-y-auto bg-gray-50">
        <VolumesPanel volumes={volumes} />
        <FeaturePanel
          features={features}
          defaults={featureDefaults}
          onChange={setFeature}
          disabled={isStreaming}
        />
        <McpPanel
          instances={mcp.instances}
          states={mcp.states}
          toggles={mcp.toggles}
          onSetToggle={mcp.setToggle}
        />
        <div className="flex-1 min-h-0">
          <SessionPicker
            sessions={sessions}
            activeSessionId={currentSessionId}
            onSelect={handleSelectSession}
          />
        </div>
      </div>
      <div className="flex flex-col flex-1 min-w-0">
        <ChatMessages
          messages={messages}
          streamingMessage={streamingMessage}
          isStreaming={isStreaming}
          error={chatError}
          toolCalls={toolCalls}
        />
        <ChatInput
          onSendMessage={sendMessage}
          onClearMessages={clearMessages}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          models={models}
          isLoadingModels={isLoadingModels}
          onRefreshModels={loadModels}
        />
      </div>
    </div>
  );
}
