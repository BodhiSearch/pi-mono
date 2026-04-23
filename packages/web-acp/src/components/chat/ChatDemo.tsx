import { useEffect } from 'react';
import { toast } from 'sonner';
import { useAcp } from '@/hooks/useAcp';
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
  } = useAcp();

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
