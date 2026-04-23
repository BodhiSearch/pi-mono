import { useEffect } from 'react';
import { toast } from 'sonner';
import { useAgent } from '@/hooks/useAgent';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';

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
  } = useAgent();

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
      />
    </>
  );
}
